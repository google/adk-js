/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';

import {Context} from '../../agents/context.js';
import {Event} from '../../events/event.js';
import {BaseTool, RunAsyncToolRequest} from '../../tools/base_tool.js';
import {AsyncQueue} from '../../utils/async_queue.js';
import {
  isZodObject,
  zodObjectToSchema,
} from '../../utils/simple_zod_to_json.js';
import {BaseNode} from '../base_node.js';
import {NodeContext} from '../node_context.js';
import {executeChildNode} from '../node_runner.js';

/**
 * A tool that executes a {@link BaseNode} (e.g. a `Workflow` or a function node)
 * on behalf of an `LlmAgent`. This is the inverse of {@link ToolNode} (which
 * exposes a tool as a workflow node): here a node/workflow is exposed to a model
 * as a callable tool.
 *
 * The wrapped node MUST declare an `inputSchema` (the tool's parameter schema is
 * derived from it). When the model calls the tool, the node runs with a
 * {@link NodeContext} bridged from the tool's agent context (sharing the
 * invocation, session, and state); the node's structured output becomes the
 * tool result.
 *
 * Ported from `google/adk-python` `tools/_node_tool.py::NodeTool`.
 *
 * The tool is marked long-running so a node that pauses for input
 * (`RequestInput`) does not force a synthetic empty response.
 */
export class NodeTool extends BaseTool {
  readonly node: BaseNode;

  constructor(node: BaseNode, name?: string, description?: string) {
    if (!node.inputSchema) {
      throw new Error(
        `Node '${node.name}' does not have an inputSchema defined. NodeTool ` +
          'requires an explicit input schema on the wrapped node.',
      );
    }
    super({
      name: name ?? node.name,
      description:
        description || node.description || `Executes the node: ${node.name}`,
      isLongRunning: true,
    });
    this.node = node;
  }

  /** Whether the node's input schema is a (Zod) object rather than a scalar. */
  private get inputIsObject(): boolean {
    return isZodObject(this.node.inputSchema);
  }

  override _getDeclaration(): FunctionDeclaration {
    let parameters: Schema;
    if (this.inputIsObject) {
      parameters = zodObjectToSchema(this.node.inputSchema as never);
    } else {
      // The GenAI API requires object-typed parameters; wrap a scalar schema
      // under a single `request` property.
      parameters = {
        type: Type.OBJECT,
        properties: {request: {type: Type.STRING}},
        required: ['request'],
      };
    }
    return {name: this.name, description: this.description, parameters};
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const nodeInput = this.inputIsObject ? args : args['request'];

    const child = await this.runNode(toolContext, nodeInput);

    if (child.interruptIds.length > 0) {
      // The node paused for input. Returning undefined leaves the (long-running)
      // tool call pending; the interrupt event has been surfaced separately so
      // the invocation can pause and resume. (Resume wiring is layered on top.)
      return undefined;
    }

    return child.output === undefined ? {result: null} : child.output;
  }

  /**
   * Runs the wrapped node with a {@link NodeContext} bridged from the agent's
   * tool context. Node events are streamed into the invocation's event queue
   * when one is present (so intermediate/interrupt events surface to the agent);
   * otherwise they are buffered and dropped (completion-only path).
   */
  private async runNode(
    toolContext: Context,
    nodeInput: unknown,
  ): Promise<NodeContext> {
    const ic = toolContext.invocationContext;
    const runId = toolContext.functionCallId ?? this.node.name;
    const channel =
      (ic as {eventQueue?: AsyncQueue<Event>}).eventQueue ??
      new AsyncQueue<Event>();

    const nodeCtx = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: this.node.name,
      runId,
      resumeInputs: collectResumeInputs(toolContext),
    });

    const base = ic.branch;
    const segment = `${this.name}@${runId}`;
    const overrideBranch = base ? `${base}.${segment}` : segment;

    return executeChildNode(nodeCtx, this.node, nodeInput, {
      runId,
      overrideBranch,
    });
  }
}

/**
 * Collects resume inputs for the node from the tool context. When the tool call
 * is being resumed after a `RequestInput`, the user's response is threaded
 * through `toolConfirmation.payload` keyed by interrupt id (see the request-input
 * resume processor).
 */
function collectResumeInputs(toolContext: Context): Record<string, unknown> {
  const payload = toolContext.toolConfirmation?.payload;
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return {};
}
