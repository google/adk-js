/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {BaseAgent} from '../../agents/base_agent.js';
import {
  InvocationContext,
  InvocationContextParams,
} from '../../agents/invocation_context.js';
import {Event} from '../../events/event.js';
import {BaseNode, BaseNodeOptions} from '../base_node.js';

/**
 * A concrete node that wraps any ADK BaseAgent (e.g., LlmAgent, SequentialAgent)
 * so it can participate as a node inside a workflow graph.
 * Enforces single-turn task execution mode and relays generated events.
 */
export class LLMAgentWrapper<
  TInput = unknown,
  TOutput = unknown,
> extends BaseNode<TInput, TOutput> {
  readonly agent: BaseAgent;

  /**
   * @param agent The BaseAgent instance to wrap.
   * @param options Optional BaseNode configuration (name override, rerunOnResume, retryConfig).
   */
  constructor(agent: BaseAgent, options?: BaseNodeOptions & {name?: string}) {
    if (!agent || typeof agent.runAsync !== 'function') {
      throw new Error('LLMAgentWrapper requires a valid BaseAgent instance.');
    }
    super(options?.name || agent.name || 'llm_agent_wrapper', options);
    this.agent = agent;
  }

  /**
   * Invokes the wrapped agent via runAsync and relays all produced events.
   */
  async *run(
    ctx: InvocationContext,
    input?: TInput,
  ): AsyncGenerator<Event, TOutput, unknown> {
    let lastOutput: unknown = undefined;

    const childCtxParams: InvocationContextParams & Record<string, unknown> = {
      ...ctx,
      agent: this.agent,
    };

    if (input !== undefined && input !== null) {
      if (typeof input === 'string') {
        childCtxParams.userContent = {
          role: 'user',
          parts: [{text: input}],
        };
      } else if (
        typeof input === 'object' &&
        'role' in input &&
        'parts' in input
      ) {
        childCtxParams.userContent = input as unknown as Content;
      }
    }

    const childCtx = new InvocationContext(childCtxParams);

    for await (const event of this.agent.runAsync(childCtx)) {
      yield event;
      if (event.content?.parts?.length) {
        const texts = event.content.parts.map((p) => p.text).filter(Boolean);
        if (texts.length > 0) {
          lastOutput = texts.join('\n');
        }
      }
      if (
        event.actions &&
        typeof event.actions === 'object' &&
        'output' in (event.actions as unknown as Record<string, unknown>)
      ) {
        lastOutput = (event.actions as unknown as Record<string, unknown>)
          .output;
      }
    }

    const finalVal = lastOutput ?? input;
    this.lastOutputPayload = finalVal;
    return finalVal as TOutput;
  }
}
