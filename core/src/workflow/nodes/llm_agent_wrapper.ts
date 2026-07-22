/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {BaseAgent} from '../../agents/base_agent.js';
import {createEvent, Event} from '../../events/event.js';
import {BaseNode, BaseNodeConfig, isContent} from '../base_node.js';
import {NodeContext} from '../node_context.js';

/** Options for an {@link LLMAgentWrapper}. */
export interface LLMAgentWrapperConfig extends Partial<
  Omit<BaseNodeConfig, 'name'>
> {
  name?: string;
}

/**
 * Runs a {@link BaseAgent} (typically an `LlmAgent`) as a workflow node in
 * `single_turn` mode: the node input is appended as a user turn, the agent runs
 * once, and its final model text becomes the node output.
 *
 * Ported (single_turn subset) from `google/adk-python`
 * `workflow/_llm_agent_wrapper.py`. The `task` and `chat` modes (FinishTaskTool,
 * task delegation, transfer, isolation scopes) are a Phase 7b continuation.
 */
export class LLMAgentWrapper extends BaseNode {
  readonly agent: BaseAgent;

  constructor(agent: BaseAgent, config: LLMAgentWrapperConfig = {}) {
    super({
      name: config.name ?? agent.name,
      description: agent.description,
      ...config,
    });
    this.agent = agent;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<Event, void, void> {
    // Append the node input as a user turn so the agent responds to it.
    if (input !== undefined && input !== null) {
      const userEvent = createEvent({
        author: 'user',
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        content: toUserContent(input),
      });
      if (ctx.isolationScope) {
        userEvent.isolationScope = ctx.isolationScope;
      }
      ctx.session.events.push(userEvent);
    }

    // Run the agent under the node's invocation context (it sets agent=itself).
    for await (const event of this.agent.runAsync(ctx.invocationContext)) {
      this.maybeSetOutput(event);
      yield event;
    }
  }

  /**
   * Promotes the final model text of an event to the node output (mirroring
   * Python `process_llm_agent_output`).
   */
  private maybeSetOutput(event: Event): void {
    if (event.partial) {
      return;
    }
    if (hasFunctionCalls(event)) {
      return;
    }
    const content = event.content;
    if (!content || content.role !== 'model' || !content.parts) {
      return;
    }
    const text = content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');

    event.output = text;
    event.nodeInfo = {...(event.nodeInfo ?? {}), messageAsOutput: true};
  }
}

function hasFunctionCalls(event: Event): boolean {
  return (event.content?.parts ?? []).some((p) => p.functionCall);
}

/** Converts an arbitrary node input into a user-role `Content`. */
function toUserContent(input: unknown): Content {
  if (isContent(input)) {
    return {...input, role: 'user'};
  }
  if (typeof input === 'string') {
    return {role: 'user', parts: [{text: input}]};
  }
  return {role: 'user', parts: [{text: JSON.stringify(input)}]};
}
