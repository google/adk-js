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
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {MessageRole} from './a2a_event.js';
import {A2ARemoteAgentRunProcessor} from './a2a_remote_agent_run_processor.js';
import {
  getUserFunctionCallAt,
  toMissingRemoteSessionParts,
} from './a2a_remote_agent_utils.js';
import {toAdkEvent} from './event_converter_utils.js';
import {getA2ASessionMetadata} from './metadata_converter_utils.js';
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
  private resolvedCard?: AgentCard;
  private client?: Client;

  constructor(private readonly a2aConfig: A2ARemoteAgentConfig) {
    super(a2aConfig);
    if (!a2aConfig.agentCard && !a2aConfig.agentCardSource) {
      throw new Error('Either agentCard or agentCardSource must be provided');
    }
    if (a2aConfig.agentCard) {
      this.resolvedCard = a2aConfig.agentCard;
    }
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    try {
      const client = await this.getOrCreateClient();
      const card = this.resolvedCard!;

      // 1. Convert current ADK state to A2A Message
      const events = context.session.events;
      if (events.length === 0) {
        throw new Error('No events in session to send');
      }

      const userFnCall = getUserFunctionCallAt(
        context.session,
        events.length - 1,
      );
      let parts: A2APart[];
      let taskId: string | undefined = undefined;
      let contextId: string | undefined = undefined;

      if (userFnCall) {
        const event = userFnCall.response;
        parts = toA2AParts(
          event.content?.parts || [],
          event.longRunningToolIds,
        );
        taskId = userFnCall.taskId;
        contextId = userFnCall.contextId;
      } else {
        const missing = toMissingRemoteSessionParts(context, context.session);
        parts = missing.parts;
        contextId = missing.contextId;
      }

      const message: Message = {
        kind: 'message',
        messageId: randomUUID(),
        role: MessageRole.USER,
        parts,
        metadata: {
          ...getA2ASessionMetadata({
            appName: context.session.appName,
            userId: context.session.userId,
            sessionId: context.session.id,
          }),
        },
      };
      if (taskId) message.taskId = taskId;
      if (contextId) message.contextId = contextId;

      const params: MessageSendParams = {
        message,
        configuration: this.a2aConfig.messageSendConfig,
      };

      const processor = new A2ARemoteAgentRunProcessor(params);

      // 2. Run BeforeRequestCallbacks
      if (this.a2aConfig.beforeRequestCallbacks) {
        for (const callback of this.a2aConfig.beforeRequestCallbacks) {
          await callback(context, params);
        }
      }

      // 3. Send Message
      // Default to streaming if supported by card, or check runConfig
      const useStreaming = card.capabilities?.streaming !== false; // Assume true if not specified, usually standard

      if (useStreaming) {
        for await (const chunk of client.sendMessageStream(params)) {
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
        const result = await client.sendMessage(params);
        // sendMessage result is Message | Task
        if (this.a2aConfig.afterRequestCallbacks) {
          // sendMessage Result doesn't strictly match A2AStreamEventData type in sdk definition for stream but they share kind
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

      yield toErrorAdkEvent({
        context,
        error,
        author: this.name,
      });
    }
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Live mode is not supported in A2ARemoteAgent yet.');
  }

  private async getOrCreateClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    const card = await this.resolveCard();
    const factory = this.a2aConfig.clientFactory || new ClientFactory();
    this.client = await factory.createFromAgentCard(card);
    return this.client;
  }

  private async resolveCard(): Promise<AgentCard> {
    if (this.resolvedCard) {
      return this.resolvedCard;
    }

    const source = this.a2aConfig.agentCardSource;
    if (!source) {
      throw new Error('No agent card or source provided');
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
      const resolver = new DefaultAgentCardResolver();
      this.resolvedCard = await resolver.resolve(source);
      return this.resolvedCard;
    }

    // Local file path resolution
    try {
      const content = await fs.readFile(source, 'utf-8');
      this.resolvedCard = JSON.parse(content) as AgentCard;
      return this.resolvedCard;
    } catch (err: unknown) {
      throw new Error(
        `Failed to read agent card from file ${source}: ${(err as Error).message}`,
      );
    }
  }
}

function toErrorAdkEvent({
  author,
  context,
  error,
}: {
  author: string;
  context: InvocationContext;
  error: Error;
}): AdkEvent {
  return createEvent({
    author,
    invocationId: context.invocationId,
    errorMessage: error.message,
    turnComplete: true,
  });
}
