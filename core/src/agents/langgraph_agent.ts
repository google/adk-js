/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../events/event.js';
import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

/**
 * Text or structured content part inside a LangGraph message content array.
 */
export interface LangGraphContentPart {
  readonly type?: string;
  readonly text?: string;
}

/**
 * Content carried by a LangGraph message (`string` or an array of content parts).
 */
export type LangGraphMessageContent =
  string | ReadonlyArray<string | LangGraphContentPart>;

/**
 * Structural representation of a message exchanged with a LangGraph graph.
 */
export interface LangGraphMessageLike {
  /**
   * Text or structured content of the message.
   */
  readonly content: LangGraphMessageContent;

  /**
   * Optional role or message type identifier (`'human'`, `'ai'`, or `'system'`).
   */
  readonly type?: string;
}

/**
 * Represents a human user message passed to a LangGraph graph.
 */
export interface LangGraphHumanMessage extends LangGraphMessageLike {
  readonly type: 'human';
  readonly content: string;
}

/**
 * Represents an AI assistant message passed to or returned by a LangGraph graph.
 */
export interface LangGraphAIMessage extends LangGraphMessageLike {
  readonly type: 'ai';
  readonly content: LangGraphMessageContent;
}

/**
 * Represents a system instruction message passed to a LangGraph graph.
 */
export interface LangGraphSystemMessage extends LangGraphMessageLike {
  readonly type: 'system';
  readonly content: string;
}

/**
 * Runnable configuration passed to a compiled LangGraph graph invocation.
 */
export interface LangGraphRunnableConfig {
  readonly configurable: {
    /**
     * Thread identifier expected in `snake_case` by LangGraph.js checkpointers.
     */
    readonly thread_id: string;
  };
}

/**
 * State snapshot returned by a compiled LangGraph graph's `getState` method.
 */
export interface LangGraphStateSnapshot {
  readonly values?: {
    readonly messages?: readonly LangGraphMessageLike[];
  };
}

/**
 * Input state passed to a compiled LangGraph graph's `invoke` method.
 */
export interface LangGraphInvokeInput {
  readonly messages: readonly LangGraphMessageLike[];
}

/**
 * Output state returned by a compiled LangGraph graph's `invoke` method.
 */
export interface LangGraphInvokeOutput {
  readonly messages?: readonly LangGraphMessageLike[];
}

/**
 * Structural interface for a compiled LangGraph graph.
 */
export interface CompiledGraphLike {
  /**
   * Optional checkpointer configured on the compiled graph for multi-turn state persistence.
   */
  readonly checkpointer?: unknown;

  /**
   * Optional helper returning the underlying graph representation.
   */
  getGraph?(...args: unknown[]): unknown;

  /**
   * Retrieves the current graph state for the given runnable configuration.
   */
  getState?(
    config: LangGraphRunnableConfig,
  ):
    | LangGraphStateSnapshot
    | undefined
    | Promise<LangGraphStateSnapshot | undefined>;

  /**
   * Invokes the compiled graph with the given message list and runnable configuration.
   */
  invoke(
    input: LangGraphInvokeInput,
    config: LangGraphRunnableConfig,
  ): LangGraphInvokeOutput | Promise<LangGraphInvokeOutput>;
}

/**
 * Configuration options for {@link LangGraphAgent}.
 */
export interface LangGraphAgentConfig extends BaseAgentConfig {
  /**
   * The compiled LangGraph graph to execute.
   */
  graph: CompiledGraphLike;

  /**
   * Optional system instruction prepended when the graph state has no existing messages.
   */
  instruction?: string;
}

/**
 * Extracts the trailing contiguous sequence of human user messages from `events`.
 *
 * @param events The session events to inspect.
 * @returns The trailing user messages in chronological order.
 */
export function getLastHumanMessages(
  events: readonly Event[],
): LangGraphHumanMessage[] {
  const messages: LangGraphHumanMessage[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (messages.length > 0 && event.author !== 'user') {
      break;
    }
    const text = event.content?.parts?.[0]?.text;
    if (event.author === 'user' && text !== undefined) {
      messages.push({type: 'human', content: text});
    }
  }
  return messages.reverse();
}

function extractMessageText(content: LangGraphMessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((part) => (typeof part === 'string' ? part : (part.text ?? '')))
    .join('');
}

const LANGGRAPH_AGENT_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.langGraphAgent',
);

/**
 * Type guard to check if an object is an instance of {@link LangGraphAgent}.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of {@link LangGraphAgent}.
 */
export function isLangGraphAgent(obj: unknown): obj is LangGraphAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    LANGGRAPH_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[LANGGRAPH_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * An agent that wraps a compiled LangGraph graph for single-turn and multi-turn execution.
 */
export class LangGraphAgent extends BaseAgent<LangGraphAgentConfig> {
  readonly [LANGGRAPH_AGENT_SIGNATURE_SYMBOL] = true;

  /**
   * The compiled LangGraph graph executed by this agent.
   */
  readonly graph: CompiledGraphLike;

  /**
   * System instruction prepended when the graph state contains no prior messages.
   */
  readonly instruction: string;

  constructor(config: LangGraphAgentConfig) {
    super(config);
    this.graph = config.graph;
    this.instruction = config.instruction ?? '';
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const config: LangGraphRunnableConfig = {
      // LangGraph.js checkpointers read `configurable.thread_id`.
      configurable: {thread_id: ctx.session.id},
    };

    let currentGraphState: LangGraphStateSnapshot | undefined;
    if (this.graph.checkpointer) {
      if (typeof this.graph.getState !== 'function') {
        throw new Error(
          `LangGraphAgent '${this.name}' requires graph.getState() when graph.checkpointer is configured.`,
        );
      }
      currentGraphState = await this.graph.getState(config);
    }
    const graphMessages = currentGraphState?.values?.messages ?? [];
    const messages: Array<
      LangGraphSystemMessage | LangGraphHumanMessage | LangGraphAIMessage
    > =
      this.instruction && graphMessages.length === 0
        ? [{type: 'system', content: this.instruction}]
        : [];

    messages.push(...this.getMessages(ctx.session.events));

    const finalState = await this.graph.invoke({messages}, config);
    const finalMessages = finalState.messages ?? [];
    const lastMessage = finalMessages[finalMessages.length - 1];
    if (!lastMessage) {
      throw new Error(
        `LangGraphAgent '${this.name}' received no messages from graph.invoke().`,
      );
    }

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [{text: extractMessageText(lastMessage.content)}],
      },
    });
  }

  protected override async *runLiveImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
    throw new Error('This is not supported yet for LangGraphAgent.');
  }

  private getMessages(
    events: readonly Event[],
  ): Array<LangGraphHumanMessage | LangGraphAIMessage> {
    if (this.graph.checkpointer) {
      return getLastHumanMessages(events);
    }
    return this.getConversationWithAgent(events);
  }

  private getConversationWithAgent(
    events: readonly Event[],
  ): Array<LangGraphHumanMessage | LangGraphAIMessage> {
    const messages: Array<LangGraphHumanMessage | LangGraphAIMessage> = [];
    for (const event of events) {
      const text = event.content?.parts?.[0]?.text;
      if (text === undefined) {
        continue;
      }
      if (event.author === 'user') {
        messages.push({type: 'human', content: text});
      } else if (event.author === this.name) {
        messages.push({type: 'ai', content: text});
      }
    }
    return messages;
  }
}
