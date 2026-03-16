/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  AgentCard,
  Message,
  MessageSendConfiguration,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  Client,
  ClientFactory,
  DefaultAgentCardResolver,
} from '@a2a-js/sdk/client';
import fs from 'fs/promises';
import {BaseAgent, BaseAgentConfig} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {logger} from '../utils/logger.js';
import {createMessage as createA2AMessage, MessageRole} from './a2a_event.js';
import {A2ARemoteAgentRunProcessor} from './a2a_remote_agent_run_processor.js';
import {
  getUserFunctionCallAt,
  toMissingRemoteSessionParts,
} from './a2a_remote_agent_utils.js';
import {toAdkEvent} from './event_converter_utils.js';
import {
  getA2ASessionMetadata,
  getA2ATaskMetadataFromAdkEvent,
} from './metadata_converter_utils.js';
import {toA2AParts} from './part_converter_utils.js';

export type A2AStreamEventData =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

/**
 * Callback called before sending a request to the remote agent.
 * Allows modifying the request parameters.
 */
export type BeforeA2ARequestCallback = (
  ctx: InvocationContext,
  params: MessageSendParams,
) => Promise<void> | void;

/**
 * Callback called after receiving a response from the remote agent.
 * Allows inspecting or modifying the response.
 */
export type AfterA2ARequestCallback = (
  ctx: InvocationContext,
  resp: A2AStreamEventData,
) => Promise<void> | void;

/**
 * Configuration for the A2ARemoteAgent.
 */
export interface A2ARemoteAgentConfig extends BaseAgentConfig {
  /**
   * Loaded AgentCard. If provided, `agentCardSource` is ignored.
   */
  agentCard?: AgentCard;
  /**
   * Source to resolve the AgentCard from. Can be an HTTP(S) URL or local file path.
   * Required if `agentCard` is not provided.
   */
  agentCardSource?: string;
  /**
   * Optional ClientFactory for creating the A2A Client.
   */
  clientFactory?: ClientFactory;
  /**
   * Optional default configuration for sending messages.
   */
  messageSendConfig?: MessageSendConfiguration;
  /**
   * Callbacks run before the remote request is sent.
   */
  beforeRequestCallbacks?: BeforeA2ARequestCallback[];
  /**
   * Callbacks run after receiving a response chunk or event, before conversion.
   */
  afterRequestCallbacks?: AfterA2ARequestCallback[];
}

/**
 * A2ARemoteAgent delegates execution to a remote agent using the A2A protocol.
 */
export class A2ARemoteAgent extends BaseAgent {
  private client?: Client;
  private card?: AgentCard;
  private isInitialized = false;

  constructor(private readonly a2aConfig: A2ARemoteAgentConfig) {
    super(a2aConfig);

    if (!a2aConfig.agentCard && !a2aConfig.agentCardSource) {
      throw new Error('Either agentCard or agentCardSource must be provided');
    }
  }

  private async init() {
    if (this.isInitialized) {
      return;
    }

    this.card = await getAgentCard(this.a2aConfig);
    const factory = this.a2aConfig.clientFactory || new ClientFactory();
    this.client = await factory.createFromAgentCard(this.card);

    this.isInitialized = true;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    try {
      await this.init();
      const params: MessageSendParams = {
        message: buildRemoteMessage(context),
        configuration: this.a2aConfig.messageSendConfig,
      };

      if (this.a2aConfig.beforeRequestCallbacks) {
        for (const callback of this.a2aConfig.beforeRequestCallbacks) {
          await callback(context, params);
        }
      }

      const processor = new A2ARemoteAgentRunProcessor(params);
      const useStreaming = this.card!.capabilities?.streaming !== false;

      if (useStreaming) {
        for await (const chunk of this.client!.sendMessageStream(params)) {
          if (this.a2aConfig.afterRequestCallbacks) {
            for (const callback of this.a2aConfig.afterRequestCallbacks) {
              await callback(context, chunk);
            }
          }

          const adkEvent = toAdkEvent(chunk, context.invocationId, this.name);
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
        if (this.a2aConfig.afterRequestCallbacks) {
          for (const callback of this.a2aConfig.afterRequestCallbacks) {
            await callback(context, result);
          }
        }
        const adkEvent = toAdkEvent(result, context.invocationId, this.name);
        if (adkEvent) {
          processor.updateCustomMetadata(adkEvent, result);
          yield adkEvent;
        }
      }
    } catch (e: unknown) {
      const error = e as Error;
      logger.error(`A2ARemoteAgent ${this.name} failed:`, error);

      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        errorMessage: error.message,
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

/**
 * Resolves the AgentCard from the provided source.
 */
async function getAgentCard(
  a2aConfig: A2ARemoteAgentConfig,
): Promise<AgentCard> {
  if (a2aConfig.agentCard) {
    return a2aConfig.agentCard;
  }

  const source = a2aConfig.agentCardSource;
  if (!source) {
    throw new Error('No agent card or source provided');
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const resolver = new DefaultAgentCardResolver();
    return await resolver.resolve(source);
  }

  try {
    const content = await fs.readFile(source, 'utf-8');
    return JSON.parse(content) as AgentCard;
  } catch (err: unknown) {
    throw new Error(
      `Failed to read agent card from file ${source}: ${(err as Error).message}`,
    );
  }
}

/**
 * Builds the MessageSendParams from the invocation context.
 */
function buildRemoteMessage(context: InvocationContext): Message {
  const events = context.session.events;
  const event = getUserFunctionCallAt(events, events.length - 1);
  const {
    taskId,
    contextId
  } = getA2ATaskMetadataFromAdkEvent(event);
  let parts: A2APart[];

  if (event) {
    parts = toA2AParts(event.content?.parts || []);
  } else {
    const missing = toMissingRemoteSessionParts(context, context.session);
    parts = missing.parts;
    contextId = missing.contextId;
  }

  return createA2AMessage({
    parts,
    taskId,
    contextId,
    role: MessageRole.USER,
    metadata: getA2ASessionMetadata({
      appName: context.session.appName,
      userId: context.session.userId,
      sessionId: context.session.id,
    }),
  });
}
