/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {
  EventActions as ApiEventActions,
  AppendAgentEngineSessionEventConfig,
  AppendAgentEngineSessionEventRequestParameters,
  EventMetadata,
  Session as VertexAiSession,
  SessionEvent as VertexAiSessionEvent,
} from '@google-cloud/vertexai/build/src/genai/types.js';
import {
  Content,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
} from '@google/genai';
import {isCompactedEvent} from '../events/compacted_event.js';
import {experimental} from '../utils/experimental.js';

import {AuthConfig} from '../auth/auth_tool.js';
import {Event, NodeInfo, Route} from '../events/event.js';
import {EventActions} from '../events/event_actions.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';
import {logger} from '../utils/logger.js';
import {
  EXPRESS_MODE_UNSUPPORTED_MESSAGE,
  getExpressModeApiKey,
} from '../utils/vertex_ai_utils.js';

import {partialCopy} from '../utils/partial_copy.js';
import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  trimTempState,
} from './base_session_service.js';
import {createSession, Session} from './session.js';

const DEFAULT_MAX_ATTEMPTS = 30;
const GRPC_NOT_FOUND = 5;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

/**
 * `eventMetadata.customMetadata` key carrying the workflow fields of an
 * {@link Event} that the Agent Engine sessions API does not model: a node's
 * `output`, `route`, `nodeInfo` and `isolationScope`, plus the
 * `agentState`/`endOfAgent` actions. It is the same escape hatch this service
 * already uses for `_compaction` and `_usage_metadata`.
 *
 * Workflow resume is driven entirely by these fields — `reconstructNodeStates`
 * groups prior events by `nodeInfo.path` and replays their `output`/`route`,
 * and a paused node recovers its input from `actions.agentState` — so an event
 * rebuilt without them makes a resumed run re-execute completed nodes.
 */
const WORKFLOW_CUSTOM_METADATA_KEY = '_workflow';

/**
 * Checks if the given URI is a Vertex AI session service URI.
 */
export function isVertexAiConnectionString(uri?: string): boolean {
  return uri?.startsWith('vertexai://') || false;
}

/**
 * Quotes a value for safe use as a Google AIP-160 filter string literal.
 *
 * Backslashes are escaped first, then double quotes, so that caller-controlled
 * input stays inside the quoted value and cannot break out to inject additional
 * filter predicates. See https://google.aip.dev/160.
 */
export function quoteFilterLiteral(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface VertexAiSessionServiceOptions {
  projectId?: string;
  location?: string;
  agentEngineId?: string;
  expressModeApiKey?: string;
  sessions?: Sessions;
}

/**
 * The parameters for `VertexAiSessionService.createSession`.
 *
 * Extends the common {@link CreateSessionRequest} with the mutually exclusive
 * session-expiration options supported by Vertex AI Agent Engine Sessions. See
 * https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/projects.locations.reasoningEngines.sessions
 */
export interface VertexAiCreateSessionRequest extends CreateSessionRequest {
  /** Lifetime relative to creation, in seconds, e.g. `'7200s'`. */
  ttl?: string;
  /** Absolute RFC 3339 UTC expiration, e.g. `'2025-10-01T00:00:00Z'`. */
  expireTime?: string;
}

/**
 * A session service implementation that integrates with Vertex AI Agent Engine Sessions.
 */
@experimental
export class VertexAiSessionService extends BaseSessionService {
  private sessions: Sessions;
  private agentEngineId?: string;
  private expressModeApiKey?: string;
  private projectId?: string;
  private location?: string;

  constructor(options: VertexAiSessionServiceOptions) {
    super();
    this.agentEngineId = options.agentEngineId;
    this.projectId = options.projectId;
    this.location = options.location;
    this.expressModeApiKey = getExpressModeApiKey(
      this.projectId,
      this.location,
      options.expressModeApiKey,
    );

    // sessions is primarily for testing to inject a mock client.
    if (options.sessions) {
      this.sessions = options.sessions;
    } else {
      if (!this.projectId || !this.location) {
        throw new Error(
          this.expressModeApiKey
            ? EXPRESS_MODE_UNSUPPORTED_MESSAGE
            : 'Project ID and Location are required.',
        );
      }
      const client = new Client({
        project: this.projectId,
        location: this.location,
      });
      this.sessions = client.agentEnginesInternal.sessions;
    }
  }

  private getReasoningEngineId(appName: string): string {
    if (this.agentEngineId) {
      return this.agentEngineId;
    }
    if (/^\d+$/.test(appName)) {
      return appName;
    }
    const pattern =
      /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;
    const match = appName.match(pattern);
    if (!match) {
      throw new Error(
        `App name ${appName} is not valid. It should either be the full ReasoningEngine resource name, or the reasoning engine id.`,
      );
    }
    return match[3];
  }

  /**
   * Creates a session on Vertex AI Agent Engine.
   *
   * @throws if both `ttl` and `expireTime` are specified.
   */
  async createSession({
    appName,
    userId,
    state,
    sessionId,
    ttl,
    expireTime,
  }: VertexAiCreateSessionRequest): Promise<Session> {
    // The API rejects both together; fail before the RPC.
    if (ttl != null && expireTime != null) {
      throw new Error(
        "Cannot specify both 'ttl' and 'expireTime' simultaneously.",
      );
    }

    const reasoningEngineId = this.getReasoningEngineId(appName);
    const filteredState = state ? trimTempState(state) : undefined;
    let apiResponse = await this.sessions.createInternal({
      name: `reasoningEngines/${reasoningEngineId}`,
      userId: userId,
      config: {
        ...(filteredState ? {sessionState: filteredState} : {}),
        ...(sessionId ? {sessionId} : {}),
        ...(ttl != null ? {ttl} : {}),
        ...(expireTime != null ? {expireTime} : {}),
      },
    });

    const operationName = apiResponse.name!;

    let attempts = 0;
    while (!apiResponse.done && attempts < DEFAULT_MAX_ATTEMPTS) {
      const [nextResponse] = await Promise.all([
        this.sessions.getSessionOperationInternal({
          operationName: operationName,
        }),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      apiResponse = nextResponse;
      attempts++;
    }

    if (!apiResponse.done) {
      throw new Error(
        `Session creation operation ${operationName} did not complete in time.`,
      );
    }

    const getSessionResponse = apiResponse.response as VertexAiSession;
    const id = getSessionResponse.name?.split('/').pop() || '';

    return createSession({
      id,
      appName,
      userId,
      state: getSessionResponse.sessionState,
      events: [],
      lastUpdateTime: getSessionResponse.updateTime
        ? Date.parse(getSessionResponse.updateTime)
        : Date.now(),
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const reasoningEngineId = this.getReasoningEngineId(appName);
    const sessionResourceName = `reasoningEngines/${reasoningEngineId}/sessions/${sessionId}`;

    try {
      let getSessionResponse: VertexAiSession | undefined;
      let eventsIterator: VertexAiSessionEvent[] = [];

      if (config && config.numRecentEvents === 0) {
        getSessionResponse = (await this.sessions.get({
          name: sessionResourceName,
        })) as VertexAiSession;
      } else {
        const listConfig: Record<string, string> = {};
        if (config && config.afterTimestamp) {
          listConfig.filter = `timestamp>="${new Date(
            config.afterTimestamp,
          ).toISOString()}"`;
        }

        const [sessionRes, eventsRes] = await Promise.all([
          this.sessions.get({name: sessionResourceName}),
          this.sessions.events.listInternal({
            name: sessionResourceName,
            config: listConfig,
          }),
        ]);
        getSessionResponse = sessionRes as VertexAiSession;
        eventsIterator =
          (eventsRes as {sessionEvents?: VertexAiSessionEvent[]})
            .sessionEvents || [];
      }

      const sessionObj = getSessionResponse!;

      if (sessionObj.userId !== userId) {
        throw new Error(
          `Session ${sessionId} does not belong to user ${userId}.`,
        );
      }

      const session = createSession({
        id: sessionId,
        appName,
        userId,
        state: sessionObj.sessionState,
        events: [],
        lastUpdateTime: sessionObj.updateTime
          ? Date.parse(sessionObj.updateTime)
          : Date.now(),
      });

      for (const event of eventsIterator) {
        session.events.push(_fromApiEvent(event));
      }

      if (config && config.numRecentEvents) {
        session.events = session.events.slice(-config.numRecentEvents);
      }

      return session;
    } catch (error: unknown) {
      const err = error as {code?: number; status?: number; message?: string};
      // gRPC transports report NOT_FOUND as a numeric `code`; the
      // `@google/genai` `ApiClient` behind the Sessions client throws an
      // `ApiError` carrying a numeric `status` instead. Matched structurally,
      // not with `instanceof`: `@google-cloud/vertexai` resolves its own copy
      // of `@google/genai`, so its `ApiError` is a different class object.
      if (
        err.code === GRPC_NOT_FOUND ||
        err.code === HTTP_NOT_FOUND ||
        err.status === HTTP_NOT_FOUND
      ) {
        return undefined;
      }
      logger.error(`Error getting session from Vertex AI: ${err.message}`);
      throw error;
    }
  }

  async listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const reasoningEngineId = this.getReasoningEngineId(appName);
    const adkSessions: Session[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response = await this.sessions.listInternal({
        name: `reasoningEngines/${reasoningEngineId}`,
        config: {
          ...(userId ? {filter: `user_id=${quoteFilterLiteral(userId)}`} : {}),
          ...(pageToken ? {pageToken} : {}),
        },
      });

      const sessions =
        (response as {sessions?: VertexAiSession[]}).sessions || [];
      for (const sessionObj of sessions) {
        const id = sessionObj.name?.split('/').pop() || '';
        adkSessions.push(
          createSession({
            id,
            appName,
            userId: sessionObj.userId,
            state: sessionObj.sessionState,
            events: [],
            lastUpdateTime: sessionObj.updateTime
              ? new Date(sessionObj.updateTime).getTime()
              : Date.now(),
          }),
        );
      }
      pageToken = (response as {nextPageToken?: string}).nextPageToken;
    } while (pageToken);

    if (order === 'asc') {
      adkSessions.sort(
        (a, b) =>
          a.lastUpdateTime - b.lastUpdateTime || a.id.localeCompare(b.id),
      );
    } else if (order === 'desc') {
      adkSessions.sort(
        (a, b) =>
          b.lastUpdateTime - a.lastUpdateTime || a.id.localeCompare(b.id),
      );
    }

    if (limit === undefined) {
      const totalItems = adkSessions.length;
      const sliced = offset ? adkSessions.slice(offset) : adkSessions;
      return {
        sessions: sliced,
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      };
    }

    const totalItems = adkSessions.length;
    const totalPages = limit === 0 ? 0 : Math.ceil(totalItems / limit);

    let effectiveOffset: number;
    let effectivePage: number;
    if (page !== undefined) {
      effectiveOffset = (page - 1) * limit;
      effectivePage = page;
    } else {
      effectiveOffset = offset ?? 0;
      effectivePage = limit === 0 ? 1 : Math.floor(effectiveOffset / limit) + 1;
    }

    return {
      sessions: adkSessions.slice(effectiveOffset, effectiveOffset + limit),
      page: effectivePage,
      limit,
      totalItems,
      totalPages,
    };
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const reasoningEngineId = this.getReasoningEngineId(appName);

    // A session may only be deleted by the user it belongs to. getSession
    // already enforces this and throws when the stored session's userId does
    // not match, so load the session first and stop if it is missing or not
    // owned by this user. This keeps deleteSession consistent with getSession
    // and with InMemorySessionService.deleteSession.
    const session = await this.getSession({
      appName,
      userId,
      sessionId,
      config: {numRecentEvents: 0},
    });
    if (!session) {
      return;
    }

    await this.sessions.delete({
      name: `reasoningEngines/${reasoningEngineId}/sessions/${sessionId}`,
    });
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await super.appendEvent({session, event});
    session.lastUpdateTime = event.timestamp;

    const reasoningEngineId = this.getReasoningEngineId(session.appName);

    const customMetadata: Record<string, unknown> = {...event.customMetadata};
    if (isCompactedEvent(event)) {
      customMetadata._compaction = {
        startTime: event.startTime,
        endTime: event.endTime,
        compactedContent: event.compactedContent,
      };
    }
    if (event.usageMetadata) {
      customMetadata._usage_metadata = event.usageMetadata;
    }
    const workflowMetadata = toWorkflowMetadata(event);
    if (workflowMetadata) {
      customMetadata[WORKFLOW_CUSTOM_METADATA_KEY] = workflowMetadata;
    }

    const config = partialCopy<AppendAgentEngineSessionEventConfig>(event, [
      'errorCode',
      'errorMessage',
    ]);
    config.actions = toApiActions(event.actions);

    // Strip Part fields the Sessions API rejects (e.g. `partMetadata`) from
    // both the wire content and the `rawEvent` blob it is stored under, so the
    // append is not rejected with 400 INVALID_ARGUMENT.
    const content = dropUnsupportedPartFields(event.content);
    config.content = content;

    config.eventMetadata = {
      ...partialCopy<EventMetadata>(event, [
        'partial',
        'turnComplete',
        'interrupted',
        'branch',
        'longRunningToolIds',
        'groundingMetadata',
      ]),
      customMetadata:
        Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
    };

    config.rawEvent = JSON.parse(JSON.stringify({...event, content})) as Record<
      string,
      unknown
    >;

    const params: AppendAgentEngineSessionEventRequestParameters = {
      name: `reasoningEngines/${reasoningEngineId}/sessions/${session.id}`,
      author: event.author || 'user',
      invocationId: event.invocationId || `inv-${Date.now()}`,
      timestamp: new Date(event.timestamp).toISOString(),
      config,
    };

    try {
      await this.sessions.events.append(params);
    } catch (error) {
      // Only a rejected payload (400) is safe to retry without `rawEvent`. Any
      // other failure may already have persisted the event, so re-appending
      // would duplicate it; let it propagate.
      if (!isInvalidArgumentError(error)) {
        throw error;
      }
      logger.warn(
        'Failed to append event with rawEvent; retrying without it. The event ' +
          'will be reconstructed from its structured fields and ' +
          'customMetadata on read.',
        error,
      );
      delete config.rawEvent;
      await this.sessions.events.append(params);
    }

    return event;
  }
}

interface WorkflowEventMetadata {
  output?: unknown;
  route?: Route;
  nodeInfo?: NodeInfo;
  isolationScope?: string;
  agentState?: Record<string, unknown>;
  endOfAgent?: boolean;
}

function toWorkflowMetadata(event: Event): WorkflowEventMetadata | undefined {
  const metadata: WorkflowEventMetadata = {};
  if (event.output !== undefined) {
    metadata.output = event.output;
  }
  if (event.route !== undefined) {
    metadata.route = event.route;
  }
  if (event.nodeInfo !== undefined) {
    metadata.nodeInfo = event.nodeInfo;
  }
  if (event.isolationScope !== undefined) {
    metadata.isolationScope = event.isolationScope;
  }
  if (event.actions?.agentState !== undefined) {
    metadata.agentState = event.actions.agentState;
  }
  if (event.actions?.endOfAgent !== undefined) {
    metadata.endOfAgent = event.actions.endOfAgent;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function applyWorkflowMetadata(
  event: Event,
  metadata: WorkflowEventMetadata,
): void {
  if (metadata.output !== undefined) {
    event.output = metadata.output;
  }
  if (metadata.route !== undefined) {
    event.route = metadata.route;
  }
  if (metadata.nodeInfo !== undefined) {
    event.nodeInfo = metadata.nodeInfo;
  }
  if (metadata.isolationScope !== undefined) {
    event.isolationScope = metadata.isolationScope;
  }
  if (metadata.agentState !== undefined) {
    event.actions.agentState = metadata.agentState;
  }
  if (metadata.endOfAgent !== undefined) {
    event.actions.endOfAgent = metadata.endOfAgent;
  }
}

/**
 * Renames `transferToAgent` to the `transferAgent` the Agent Engine sessions
 * API actually defines, mirroring what `_fromApiEvent` reads back and what
 * adk-python writes. Returns a new object: `partialCopy` is shallow, so
 * rewriting the event's own `actions` in place would mutate the caller's event.
 */
function toApiActions(
  actions: EventActions | undefined,
): ApiEventActions | undefined {
  if (!actions) {
    return undefined;
  }
  const {transferToAgent, ...rest} = actions;
  return {
    ...rest,
    ...(transferToAgent !== undefined ? {transferAgent: transferToAgent} : {}),
  } as ApiEventActions;
}

/**
 * Returns a copy of `content` without Part fields the Agent Engine Sessions
 * API rejects, passing `undefined` through unchanged.
 *
 * `partMetadata` is a Gemini Developer API-only field; the Sessions API fails
 * appendEvent with 400 INVALID_ARGUMENT ("Unknown name \"part_metadata\"").
 * The input is never mutated, so the caller's event keeps its metadata.
 */
function dropUnsupportedPartFields(
  content: Content | undefined,
): Content | undefined {
  if (!content?.parts) {
    return content;
  }
  return {
    ...content,
    parts: content.parts.map((part) => {
      const copy = {...part};
      delete copy.partMetadata;
      return copy;
    }),
  };
}

/**
 * True when the service rejected the request payload itself, which is what an
 * API that does not know `rawEvent` returns. Any other failure must propagate:
 * the event may already be persisted, so retrying would append it twice.
 *
 * Matched structurally on the `ApiError`'s `status`, for the reason given in
 * getSession's catch.
 */
function isInvalidArgumentError(error: unknown): boolean {
  return (error as {status?: number} | null)?.status === HTTP_BAD_REQUEST;
}

interface ExtendedEventActions extends EventActions {
  compaction?: {
    startTime: number;
    endTime: number;
    compactedContent: string;
  };
}

interface ExtendedEvent extends Event {
  actions: ExtendedEventActions;
  isCompacted?: boolean;
  startTime?: number;
  endTime?: number;
  compactedContent?: string;
}

function _fromApiEvent(apiEventObj: VertexAiSessionEvent): Event {
  const rawEvent = apiEventObj.rawEvent;
  if (rawEvent) {
    const event = JSON.parse(JSON.stringify(rawEvent)) as Event;
    event.id = apiEventObj.name?.split('/').pop() || '';
    event.invocationId = apiEventObj.invocationId || '';
    event.author = apiEventObj.author;
    if (apiEventObj.timestamp) {
      event.timestamp = new Date(apiEventObj.timestamp).getTime();
    }
    return event;
  }

  const actions = apiEventObj.actions || {};
  const eventMetadata = apiEventObj.eventMetadata || {};

  let customMetadata = eventMetadata.customMetadata as
    | Record<string, unknown>
    | undefined;
  let compactionData: {
    startTime: number;
    endTime: number;
    compactedContent: string;
  } | null = null;
  let usageMetadataData = null;
  let workflowData: WorkflowEventMetadata | undefined;

  if (customMetadata) {
    customMetadata = {...customMetadata};
    if (customMetadata._compaction) {
      compactionData = customMetadata._compaction as {
        startTime: number;
        endTime: number;
        compactedContent: string;
      };
      delete customMetadata._compaction;
    }
    if (customMetadata._usage_metadata) {
      usageMetadataData = customMetadata._usage_metadata;
      delete customMetadata._usage_metadata;
    }
    if (customMetadata[WORKFLOW_CUSTOM_METADATA_KEY]) {
      workflowData = customMetadata[
        WORKFLOW_CUSTOM_METADATA_KEY
      ] as WorkflowEventMetadata;
      delete customMetadata[WORKFLOW_CUSTOM_METADATA_KEY];
    }
    if (Object.keys(customMetadata).length === 0) {
      customMetadata = undefined;
    }
  }

  const eventActions: ExtendedEventActions = {
    stateDelta: (actions['stateDelta'] as {[key: string]: unknown}) || {},
    artifactDelta: (actions['artifactDelta'] as {[key: string]: number}) || {},
    requestedAuthConfigs:
      (actions.requestedAuthConfigs as Record<string, AuthConfig>) || {},
    requestedToolConfirmations:
      ((actions as Record<string, unknown>)[
        'requestedToolConfirmations'
      ] as Record<string, ToolConfirmation>) || {},
    skipSummarization: actions['skipSummarization'] as boolean | undefined,
    // Earlier adk-js versions copied `event.actions` onto the request
    // verbatim, so sessions they wrote store ADK's own `transferToAgent` key.
    transferToAgent: (actions['transferAgent'] ??
      (actions as Record<string, unknown>)['transferToAgent']) as
      | string
      | undefined,
    escalate: actions['escalate'] as boolean | undefined,
    compaction: compactionData || undefined,
  };

  const event: ExtendedEvent = {
    id: apiEventObj.name?.split('/').pop() || '',
    invocationId: apiEventObj.invocationId || '',
    author: apiEventObj.author,
    actions: eventActions,
    content: apiEventObj.content as unknown as Content,
    timestamp: apiEventObj.timestamp
      ? new Date(apiEventObj.timestamp).getTime()
      : Date.now(),
    errorCode: apiEventObj.errorCode?.toString(),
    errorMessage: apiEventObj.errorMessage,
    partial: eventMetadata['partial'] as boolean | undefined,
    turnComplete: eventMetadata['turnComplete'] as boolean | undefined,
    interrupted: eventMetadata['interrupted'] as boolean | undefined,
    branch: eventMetadata['branch'] as string | undefined,
    customMetadata,
    longRunningToolIds: eventMetadata['longRunningToolIds'] as
      | string[]
      | undefined,
    groundingMetadata: eventMetadata['groundingMetadata'] as
      | GroundingMetadata
      | undefined,
    usageMetadata:
      usageMetadataData as unknown as GenerateContentResponseUsageMetadata,
  };

  if (compactionData) {
    event.isCompacted = true;
    event.startTime = compactionData.startTime;
    event.endTime = compactionData.endTime;
    event.compactedContent = compactionData.compactedContent;
  }

  if (workflowData) {
    applyWorkflowMetadata(event, workflowData);
  }

  return event;
}
