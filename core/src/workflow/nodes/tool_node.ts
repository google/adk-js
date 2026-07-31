/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {createEvent, Event} from '../../events/event.js';
import {BaseTool, isBaseTool} from '../../tools/base_tool.js';
import {randomUUID} from '../../utils/env_aware_utils.js';
import {BaseNode, BaseNodeConfig, isContent} from '../base_node.js';
import {NodeContext} from '../node_context.js';
import {registerNodeBuilder} from '../utils/workflow_graph_utils.js';
/** Options for a {@link ToolNode}. */
export interface ToolNodeConfig extends Partial<Omit<BaseNodeConfig, 'name'>> {
  /** Optional name override; defaults to the tool's name. */
  name?: string;
}

/**
 * A node that wraps an ADK {@link BaseTool} and invokes it with the node input
 * as its arguments.
 *
 * Ported from `google/adk-python` `workflow/_tool_node.py`. The node input is
 * coerced to a tool-args object: genai `Content` → its text; a JSON string →
 * parsed object; `null`/empty → `{}`.
 */
export class ToolNode extends BaseNode {
  readonly tool: BaseTool;

  constructor(tool: BaseTool, config: ToolNodeConfig = {}) {
    super({name: config.name ?? tool.name, ...config});
    this.tool = tool;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<Event, void, void> {
    const toolContext = new Context({
      invocationContext: ctx.invocationContext,
      functionCallId: randomUUID(),
    });

    const args = coerceToolArgs(input);
    const response = await this.tool.runAsync({args, toolContext});

    const stateDelta =
      Object.keys(toolContext.actions.stateDelta).length > 0
        ? {...toolContext.actions.stateDelta}
        : undefined;

    if (response !== undefined && response !== null) {
      yield createEvent({
        author: this.name,
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        output: response,
        actions: stateDelta ? {stateDelta} : undefined,
      });
    } else if (stateDelta) {
      yield createEvent({
        author: this.name,
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        actions: {stateDelta},
      });
    }
  }
}

/** Coerces arbitrary node input into a tool-arguments record. */
function coerceToolArgs(input: unknown): Record<string, unknown> {
  let args: unknown = input;

  if (isContent(args)) {
    args = extractText(args);
  }

  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) {
      args = null;
    } else {
      try {
        args = JSON.parse(trimmed);
      } catch {
        // Leave as the raw string; validated below.
      }
    }
  }

  if (args === null || args === undefined) {
    return {};
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError(
      'The input to ToolNode must be a dictionary of tool arguments or null, ' +
        `but got ${typeof args}.`,
    );
  }
  return args as Record<string, unknown>;
}

function extractText(content: {parts?: Array<{text?: string}>}): string {
  return (content.parts ?? []).map((p) => p.text ?? '').join('');
}

/**
 * Registers the builder that turns a {@link BaseTool} into a {@link ToolNode},
 * so `node(tool)` and graph parsing work without the engine statically
 * importing this module.
 */
registerNodeBuilder({
  match: (value): boolean => isBaseTool(value),
  build: (value, options) => new ToolNode(value as BaseTool, options),
});
