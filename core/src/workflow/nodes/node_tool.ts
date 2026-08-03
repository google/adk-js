/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';

import {Context} from '../../agents/context.js';
import {BaseTool, RunAsyncToolRequest} from '../../tools/base_tool.js';
import {
  isZodObject,
  zodObjectToSchema,
} from '../../utils/simple_zod_to_json.js';
import {BaseNode} from '../base_node.js';
import {NodeContext} from '../node_context.js';
import {executeChildNode} from '../node_runner.js';

/**
 * A unique symbol branding {@link NodeTool} instances (see `isNodeTool`).
 */
const NODE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.workflow.nodeTool');

/**
 * Maximum nesting depth for node-as-tool executions, guarding against
 * `node -> tool -> node` recursion (a node exposed as a tool whose agent can
 * call that same tool again — unbounded model + tool spend otherwise).
 */
const MAX_NODE_TOOL_DEPTH = 8;

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
  /** Brand identifying this object as a {@link NodeTool} (see `isNodeTool`). */
  readonly [NODE_TOOL_SIGNATURE_SYMBOL] = true;

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

  override _getDeclaration(): FunctionDeclaration {
    const schema = this.node.inputSchema;
    let parameters: Schema;
    // Narrow inline so `zodObjectToSchema` typechecks without a cast.
    if (schema && isZodObject(schema)) {
      parameters = zodObjectToSchema(schema);
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

  /** Whether the node's input schema is a (Zod) object rather than a scalar. */
  private get inputIsObject(): boolean {
    return isZodObject(this.node.inputSchema);
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
   * tool context. Node events are streamed into the invocation's event queue so
   * intermediate/interrupt events surface to the agent (and a paused node can be
   * resumed). Requires being invoked from an `LlmAgent` tool-call step, which is
   * what provides that queue and the function-call id.
   */
  private async runNode(
    toolContext: Context,
    nodeInput: unknown,
  ): Promise<NodeContext> {
    const ic = toolContext.invocationContext;

    // A paused node's interrupt event must reach the session, so an event queue
    // is required; without one the pause would be a silent dead end.
    const channel = ic.eventQueue;
    if (!channel) {
      throw new Error(
        `NodeTool '${this.name}' requires an invocation event queue; ` +
          'it must be invoked from an LlmAgent tool-call step.',
      );
    }

    // A stable, unique run id per tool call: reused across resume so the paused
    // run can be matched. (A shared fallback would collapse distinct calls.)
    const runId = toolContext.functionCallId;
    if (!runId) {
      throw new Error(
        `NodeTool '${this.name}' requires a function-call id; ` +
          'it must be invoked from an LlmAgent tool-call step.',
      );
    }

    if (ic.nodeToolDepth >= MAX_NODE_TOOL_DEPTH) {
      throw new Error(
        `NodeTool '${this.name}': node-tool nesting exceeded ` +
          `${MAX_NODE_TOOL_DEPTH} (possible node -> tool -> node recursion).`,
      );
    }
    // Run the node (and anything it reaches) at depth+1 so the guard above trips
    // on unbounded recursion; the clone carries the depth across agent runs.
    const childIc = ic.clone({nodeToolDepth: ic.nodeToolDepth + 1});

    const nodeCtx = new NodeContext({
      invocationContext: childIc,
      channel,
      // Empty so executeChildNode's path is a single segment (the node name),
      // not the node name doubled.
      nodePath: '',
      runId,
      resumeInputs: collectResumeInputs(toolContext),
    });

    const base = childIc.branch;
    const segment = `${this.name}@${runId}`;
    const overrideBranch = base ? `${base}.${segment}` : segment;

    return executeChildNode({
      parent: nodeCtx,
      node: this.node,
      input: nodeInput,
      options: {runId, overrideBranch},
    });
  }
}

/**
 * Type guard for {@link NodeTool}. Matches on the brand rather than `instanceof`
 * so it stays correct across package copies (mirrors `isBaseTool`).
 */
export function isNodeTool(value: unknown): value is NodeTool {
  return (
    typeof value === 'object' &&
    value !== null &&
    NODE_TOOL_SIGNATURE_SYMBOL in value &&
    value[NODE_TOOL_SIGNATURE_SYMBOL] === true
  );
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
