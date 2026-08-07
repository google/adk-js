/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionCall} from '@google/genai';
import {handleFunctionCallList} from '../../agents/functions.js';
import {Event, getFunctionResponses} from '../../events/event.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseNode, BaseNodeConfig, isContent} from '../base_node.js';
import {NodeContext} from '../node_context.js';

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
 *
 * The tool runs through the canonical execution path
 * ({@link handleFunctionCallList}), so the plugin `before`/`after`/`onError`
 * tool callbacks, the confirmation gate, telemetry, and everything the tool
 * writes to its context (`stateDelta`, `artifactDelta`, requested credentials /
 * confirmations, …) all apply — exactly as when the same tool is called from an
 * LLM agent. The emitted event carries a canonical `functionResponse` part.
 */
export class ToolNode extends BaseNode {
  readonly tool: BaseTool;

  constructor(tool: BaseTool, config: ToolNodeConfig = {}) {
    // Spread first so an explicit `undefined` name in `config` can't clobber
    // the fallback (which BaseNode requires to be non-empty).
    super({...config, name: config.name ?? tool.name});
    if (tool.isLongRunning) {
      // Long-running/HITL tools suspend the invocation; that machinery lands in
      // a later part. Fail loud rather than silently completing the call.
      throw new Error(
        `ToolNode does not support long-running tools yet (tool '${tool.name}').`,
      );
    }
    this.tool = tool;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<Event, void, void> {
    // Coerce the node input into a tool-args object, then re-validate it against
    // `inputSchema`. BaseNode.validateInput skips genai `Content` up front (a
    // node coerces it itself), so this is the only point model-authored args are
    // checked before reaching the tool.
    const args = this.validateInput(coerceToolArgs(input)) as Record<
      string,
      unknown
    >;

    // Deterministic id so credential/confirmation requests can be matched to
    // their resume response across turns/retries (a fresh UUID never would).
    const functionCall: FunctionCall = {
      name: this.tool.name,
      args,
      id: `${ctx.nodePath}:${ctx.runId}`,
    };

    const responseEvent = await handleFunctionCallList({
      invocationContext: ctx.invocationContext,
      functionCalls: [functionCall],
      toolsDict: {[this.tool.name]: this.tool},
      // Plugin callbacks still run via invocationContext.pluginManager; there is
      // no agent-level tool-callback list on a workflow node.
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    if (!responseEvent) {
      return;
    }
    responseEvent.author = this.name;
    // Surface the tool's (post-callback) response as the node output so it can
    // drive downstream nodes, while the event keeps its canonical
    // functionResponse content for history.
    const responses = getFunctionResponses(responseEvent);
    if (responses.length > 0) {
      responseEvent.output = responses[0].response;
    }
    yield responseEvent;
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
        // Leave as the raw string; rejected below.
      }
    }
  }

  if (args === null || args === undefined) {
    return {};
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError(
      'The input to ToolNode must be an object of tool arguments or null, ' +
        `but got ${typeof args}.`,
    );
  }
  return args as Record<string, unknown>;
}

function extractText(content: {parts?: Array<{text?: string}>}): string {
  return (content.parts ?? []).map((p) => p.text ?? '').join('');
}

// The builder that turns a BaseTool into a ToolNode is wired into the static
// NODE_BUILDERS list in ../node_builders.ts.
