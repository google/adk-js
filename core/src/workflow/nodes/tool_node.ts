/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../../agents/invocation_context.js';
import {createEvent, Event} from '../../events/event.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseNode, BaseNodeOptions} from '../base_node.js';

/**
 * A concrete node that wraps an ADK BaseTool (or FunctionTool) so it can be executed
 * directly as a step in a workflow graph without requiring an LLM wrapper.
 */
export class ToolNode<
  TInput = Record<string, unknown>,
  TOutput = unknown,
> extends BaseNode<TInput, TOutput> {
  readonly tool: BaseTool;

  /**
   * @param tool The BaseTool instance to execute when this node runs.
   * @param options Optional BaseNode configuration (name override, rerunOnResume, retryConfig).
   */
  constructor(tool: BaseTool, options?: BaseNodeOptions & {name?: string}) {
    if (!tool || typeof tool.runAsync !== 'function') {
      throw new Error(
        'ToolNode requires a valid BaseTool instance with runAsync().',
      );
    }
    super(options?.name || tool.name || 'tool_node', options);
    this.tool = tool;
  }

  /**
   * Executes the wrapped tool using parameters from the input payload.
   */
  async *run(
    ctx: InvocationContext,
    input?: TInput,
  ): AsyncGenerator<Event, TOutput, unknown> {
    const params = typeof input === 'object' && input !== null ? input : {};
    const result = await this.tool.runAsync(
      {invocationContext: ctx},
      params as Record<string, unknown>,
    );

    const event = createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      actions: {
        toolExecution: {
          name: this.tool.name,
          input: params,
          output: result,
        },
      },
    });

    yield event;
    this.lastOutputPayload = result;
    return result as TOutput;
  }
}
