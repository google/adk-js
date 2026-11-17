/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  AGENT_CARD_PATH,
  AgentCard,
  Message,
  SendMessageConfiguration,
  SendMessageRequest,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  Client,
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client';
import {BaseAgent, BaseAgentConfig} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {propagateTraceContext} from '../telemetry/api/instrumentation.js';
import {getErrorMessage} from '../utils/error_utils.js';
import {fetchWithTimeout} from '../utils/fetch_utils.js';
import {logger} from '../utils/logger.js';
import {
  createMessage,
  isTask,
  isTurnEndingTaskState,
  Role,
} from './a2a_event.js';
import {A2ARemoteAgentRunProcessor} from './a2a_remote_agent_run_processor.js';
import {
  getUserFunctionCallAt,
  peerRequestedCallIds,
  toForwardableA2AParts,
  toMissingRemoteSessionParts,
} from './a2a_remote_agent_utils.js';
import {resolveAgentCard, ResolveAgentCardOptions} from './agent_card.js';
import {toAdkEvent} from './event_converter_utils.js';
import {buildA2ARequestLog, buildA2AResponseLog} from './log_utils.js';
import {
  A2A_METADATA_KEY_PREFIX,
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';

export {AGENT_CARD_PATH};

/**
 * Type alias for A2A stream event data: the payload of one A2A v1.0
 * `StreamResponse`, or the result of a `SendMessage` call.
 */
export type A2AStreamEventData =
  Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/**
 * Callback called before sending a request to the remote agent.
 * Allows modifying the request parameters.
 *
 * @param ctx - The current invocation context, providing access to session
 *   state, agent metadata, and services.
 * @param params - The A2A `SendMessageRequest` that will be sent to the
 *   remote agent. Mutations to this object are reflected in the outgoing
 *   request.
 * @returns A Promise or void. Returning a rejected Promise aborts the request.
 */
export type BeforeA2ARequestCallback = (
  ctx: InvocationContext,
  params: SendMessageRequest,
) => Promise<void> | void;

/**
 * Callback called after receiving a response from the remote agent.
 * Allows inspecting or modifying the response.
 *
 * @param ctx - The current invocation context, providing access to session
 *   state, agent metadata, and services.
 * @param resp - The raw A2A stream event data received from the remote agent,
 *   before conversion to an ADK event.
 * @returns A Promise or void. Returning a rejected Promise stops further
 *   processing of the response.
 */
export type AfterA2ARequestCallback = (
  ctx: InvocationContext,
  resp: A2AStreamEventData,
) => Promise<void> | void;

/**
 * Configuration for the A2ARemoteAgent.
 */
export interface RemoteA2AAgentConfig extends BaseAgentConfig {
  /**
   * Loaded AgentCard or URL to AgentCard.
   *
   * The agent speaks the A2A protocol version the card declares: A2A v1.0
   * when the card lists a v1.0 interface, and otherwise A2A v0.3. A card in
   * the A2A v0.3 shape (with a top-level `url`) is accepted too, and is spoken
   * to over v0.3.
   */
  agentCard?: AgentCard | string;

  /**
   * Controls how a fetched agent card's RPC URL(s) are validated against
   * the location the card was fetched from. Only relevant when
   * {@link RemoteA2AAgentConfig.agentCard} is a URL rather than an
   * already-loaded card object; see {@link ResolveAgentCardOptions} for
   * what each option relaxes and why both default to failing closed.
   */
  resolveAgentCardOptions?: ResolveAgentCardOptions;

  /**
   * Optional pre-initialized Client for connection pooling.
   *
   * A provided client sends requests as it is configured, so the default
   * trace context propagation does not apply to it.
   */
  client?: Client;

  /**
   * Optional ClientFactory for creating the A2A Client.
   *
   * Clients from a provided factory send requests as it is configured, so the
   * default trace context propagation does not apply to them.
   */
  clientFactory?: ClientFactory;
  /**
   * Optional default configuration for sending messages. Fields left unset
   * take their A2A defaults.
   */
  messageSendConfig?: Partial<SendMessageConfiguration>;
  /**
   * Callbacks run before the remote request is sent.
   */
  beforeRequestCallbacks?: BeforeA2ARequestCallback[];
  /**
   * Callbacks run after receiving a response chunk or event, before conversion.
   */
  afterRequestCallbacks?: AfterA2ARequestCallback[];
  /**
   * Optional request-level metadata to include in the A2A message send request.
   * If omitted, defaults to `context.a2aMetadata` from the current invocation context.
   */
  metadata?: Record<string, unknown>;
  /**
   * Maximum time to wait for the response headers of each HTTP request the
   * agent sends with its own transports, in milliseconds. Defaults to 600000
   * (10 minutes).
   *
   * It bounds the agent card fetch from an `http(s)` URL and each message
   * request of the default client factory. A request that exceeds it is
   * aborted and the run yields an error event. A response stream that has
   * started is not bounded. A provided
   * {@link RemoteA2AAgentConfig.client} or
   * {@link RemoteA2AAgentConfig.clientFactory} sends requests as it is
   * configured, so the timeout does not apply to its message requests.
   */
  timeoutMs?: number;
}

/** Default of {@link RemoteA2AAgentConfig.timeoutMs}. */
const DEFAULT_TIMEOUT_MS = 600_000;

const MAX_CARD_DESCRIPTION_CHARS = 1024;
const CARD_DESCRIPTION_TRUNCATION_SUFFIX = '... [truncated]';
const QUOTED_CONTENT_BEGIN = '<<<BEGIN_QUOTED_AGENT_CONTENT>>>';
const QUOTED_CONTENT_END = '<<<END_QUOTED_AGENT_CONTENT>>>';
const QUOTED_CONTENT_ELIDED = '<<<ELIDED_MARKER>>>';

/**
 * Quotes a fetched remote agent card description so it is treated as
 * untrusted data rather than instructions when embedded in a parent prompt.
 */
function adoptCardDescription(
  description: string,
  agentCardSource?: string,
): string {
  if (
    !agentCardSource ||
    (!agentCardSource.startsWith('http://') &&
      !agentCardSource.startsWith('https://'))
  ) {
    return description;
  }
  let capped = description.slice(0, MAX_CARD_DESCRIPTION_CHARS);
  if (capped.length < description.length) {
    capped += CARD_DESCRIPTION_TRUNCATION_SUFFIX;
  }
  const elided = capped
    .replaceAll(QUOTED_CONTENT_BEGIN, QUOTED_CONTENT_ELIDED)
    .replaceAll(QUOTED_CONTENT_END, QUOTED_CONTENT_ELIDED);
  return `${QUOTED_CONTENT_BEGIN}\n${elided}\n${QUOTED_CONTENT_END}`;
}

/**
 * Creates the default client factory, whose JSON-RPC and REST transports send
 * the active trace context with each request, streaming ones included, and
 * abort a request whose response headers do not arrive within `timeoutMs`.
 *
 * The client speaks A2A v1.0 when the card declares a v1.0 interface. For a
 * card that declares only A2A v0.3 interfaces, the transports fall back to the
 * v0.3 compatibility transports of `@a2a-js/sdk`.
 */
function createTracePropagatingClientFactory(timeoutMs: number): ClientFactory {
  const fetchImpl = propagateTraceContext(fetchWithTimeout({timeoutMs}));
  const legacyCompat = {enabled: true};
  return new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({legacyCompat}),
      transports: [
        new JsonRpcTransportFactory({fetchImpl, legacyCompat}),
        new RestTransportFactory({fetchImpl, legacyCompat}),
      ],
    }),
  );
}

/**
 * Fills the fields of a message send configuration that the caller left unset
 * with their A2A defaults.
 */
function toSendMessageConfiguration(
  config: Partial<SendMessageConfiguration> | undefined,
): SendMessageConfiguration | undefined {
  if (!config) {
    return undefined;
  }
  return {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately: false,
    ...config,
  };
}

/**
 * Returns the part of a streamed event that is new output.
 *
 * An A2A v1.0 stream opens with the task. When the request continues an
 * existing task, that task carries the artifacts and history of the earlier
 * turns, which were already relayed; the output of this turn arrives in the
 * updates that follow. So a task that has not ended the turn is converted
 * without its artifacts and history. A task that ended the turn is the result
 * itself and is converted whole.
 */
function toStreamedEvent(event: A2AStreamEventData): A2AStreamEventData {
  if (isTask(event) && !isTurnEndingTaskState(event)) {
    return {...event, artifacts: [], history: []};
  }
  return event;
}

/**
 * RemoteA2AAgent delegates execution to a remote agent using the A2A protocol.
 *
 * @remarks
 * A cloned `RemoteA2AAgent` (via {@link BaseAgent.clone}) is a fresh,
 * uninitialized instance that re-resolves its client and card on first use.
 */
export class RemoteA2AAgent extends BaseAgent<RemoteA2AAgentConfig> {
  /**
   * Description of the remote agent, auto-populated from the resolved
   * `AgentCard` when omitted in config.
   */
  override description: string;
  private client?: Client;
  private card?: AgentCard;
  private readonly agentCardSource?: string;
  private isInitialized = false;
  private readonly timeoutMs: number;

  constructor(private readonly a2aConfig: RemoteA2AAgentConfig) {
    super(a2aConfig);
    let description = a2aConfig.description ?? '';
    if (typeof a2aConfig.agentCard === 'string') {
      const trimmed = a2aConfig.agentCard.trim();
      if (!trimmed) {
        throw new Error(
          a2aConfig.client
            ? 'Agent card source string cannot be empty.'
            : 'Either AgentCard or Client must be provided',
        );
      }
      this.agentCardSource = trimmed;
    } else if (!a2aConfig.agentCard && !a2aConfig.client) {
      throw new Error('Either AgentCard or Client must be provided');
    } else if (
      !description &&
      a2aConfig.agentCard !== null &&
      typeof a2aConfig.agentCard === 'object' &&
      a2aConfig.agentCard.description
    ) {
      description = a2aConfig.agentCard.description;
    }
    this.description = description;
    this.timeoutMs = a2aConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error(
        `The timeoutMs of remote A2A agent ${this.name} must be a positive finite number, but it is ${this.timeoutMs}.`,
      );
    }
  }

  private async init() {
    if (this.isInitialized) {
      return;
    }

    if (this.a2aConfig.client) {
      this.client = this.a2aConfig.client;
    }

    const cardInput = this.agentCardSource ?? this.a2aConfig.agentCard;
    if (cardInput) {
      this.card = await resolveAgentCard(cardInput, {
        ...this.a2aConfig.resolveAgentCardOptions,
        timeoutMs: this.timeoutMs,
      });

      if (!this.description && this.card.description) {
        this.description = adoptCardDescription(
          this.card.description,
          this.agentCardSource,
        );
      }

      if (!this.client) {
        const factory =
          this.a2aConfig.clientFactory ??
          createTracePropagatingClientFactory(this.timeoutMs);
        this.client = await factory.createFromAgentCard(this.card);
      }
    }

    this.isInitialized = true;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    try {
      await this.init();
    } catch (e: unknown) {
      logger.error(`A2ARemoteAgent ${this.name} failed to initialize:`, e);

      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        branch: context.branch,
        errorMessage: `Failed to initialize remote A2A agent ${this.name}: ${getErrorMessage(e)}`,
        turnComplete: true,
      });
      return;
    }

    let params: SendMessageRequest | undefined;
    try {
      // 1. Convert current ADK state to A2A Message
      const events = context.session.events;
      if (events.length === 0) {
        throw new Error('No events in session to send');
      }

      const userFnCall = getUserFunctionCallAt(
        context.session,
        events.length - 1,
        this.name,
      );
      let parts: A2APart[];
      let taskId: string | undefined = undefined;
      let contextId: string | undefined = undefined;

      if (userFnCall) {
        const event = userFnCall.response;
        // Route through the shared scrub: this credential response must not
        // cross the trust boundary unless its id is one the peer itself
        // exclusively requested. Computed over the full session, not just
        // this one response event: an id counts as peer-requested only if
        // EVERY event that issued a call for it was authored by the peer,
        // so the check needs the whole history to catch a local request
        // whose id the peer's own event reuses.
        const peerRequestedIds = peerRequestedCallIds(events, this.name);
        parts = toForwardableA2AParts(
          event.content,
          event.longRunningToolIds,
          peerRequestedIds,
        );
        taskId = userFnCall.taskId;
        contextId = userFnCall.contextId;
      } else {
        const missing = toMissingRemoteSessionParts(context, context.session);
        parts = missing.parts;
        contextId = missing.contextId;
      }

      const message: Message = createMessage({
        role: Role.ROLE_USER,
        parts,
        taskId,
        contextId,
        metadata: getA2ASessionMetadata({
          appName: context.session.appName,
          userId: context.session.userId,
          sessionId: context.session.id,
        }),
      });

      const metadata = this.a2aConfig.metadata ?? context.a2aMetadata;
      params = {
        tenant: '',
        message,
        configuration: toSendMessageConfiguration(
          this.a2aConfig.messageSendConfig,
        ),
        metadata,
      };

      const processor = new A2ARemoteAgentRunProcessor(params);

      if (this.a2aConfig.beforeRequestCallbacks) {
        for (const callback of this.a2aConfig.beforeRequestCallbacks) {
          await callback(context, params);
        }
      }

      logger.debug(buildA2ARequestLog(params));

      const useStreaming = this.card
        ? this.card.capabilities?.streaming !== false
        : true;
      if (useStreaming) {
        for await (const response of this.client!.sendMessageStream(params)) {
          const chunk: A2AStreamEventData | undefined = response.payload?.value;
          if (!chunk) {
            continue;
          }
          logger.debug(buildA2AResponseLog(chunk));

          if (this.a2aConfig.afterRequestCallbacks) {
            for (const callback of this.a2aConfig.afterRequestCallbacks) {
              await callback(context, chunk);
            }
          }

          const adkEvent = toAdkEvent(
            toStreamedEvent(chunk),
            context.invocationId,
            this.name,
            context.branch,
          );
          if (!adkEvent) {
            continue;
          }

          processor.updateCustomMetadata(adkEvent, chunk);

          const eventsToEmit = processor.aggregatePartial(
            context,
            chunk,
            adkEvent,
          );
          for (const ev of eventsToEmit) {
            yield ev;
          }
        }
      } else {
        const result = await this.client!.sendMessage(params);
        logger.debug(buildA2AResponseLog(result));

        if (this.a2aConfig.afterRequestCallbacks) {
          for (const callback of this.a2aConfig.afterRequestCallbacks) {
            await callback(context, result);
          }
        }
        const adkEvent = toAdkEvent(
          result,
          context.invocationId,
          this.name,
          context.branch,
        );
        if (adkEvent) {
          processor.updateCustomMetadata(adkEvent, result);
          yield adkEvent;
        }
      }
    } catch (e: unknown) {
      logger.error(`A2ARemoteAgent ${this.name} failed:`, e);

      const errorMessage = `A2A request failed: ${getErrorMessage(e)}`;
      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        branch: context.branch,
        errorMessage,
        customMetadata: {
          [`${A2A_METADATA_KEY_PREFIX}error`]: errorMessage,
          ...(params
            ? {
                [`${A2A_METADATA_KEY_PREFIX}request`]:
                  SendMessageRequest.toJSON(params),
              }
            : {}),
        },
        turnComplete: true,
      });
    }
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Live mode is not supported in A2ARemoteAgent yet.');
  }
}
