/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {BaseNode} from './base_node.js';
import {consumeGenerator, getOrInitAgentStates} from './node_runner.js';
import {NodeState, NodeStatus, isNodeState} from './node_state.js';
import {FunctionNode, FunctionNodeHandler} from './nodes/function_node.js';

/**
 * Options for `runNode`.
 */
export interface RunNodeOptions {
  /**
   * Custom execution ID override for this node execution.
   * If not provided, a deterministic execution ID based on branch and node name is used.
   */
  customExecutionId?: string;
}

/**
 * Programmatically runs a target node (or function) inside the invocation context,
 * checking and persisting state checkpoints (`InvocationContext.agentStates[execId]`).
 * Essential for dynamic workflows where execution flow is controlled by TS code.
 *
 * @param ctx The current invocation context.
 * @param nodeOrFunc A BaseNode instance or function handler to execute.
 * @param input Optional input payload.
 * @param options Optional settings (customExecutionId).
 * @returns Promise resolving to the final output payload of the node.
 */
export async function runNode<TInput = unknown, TOutput = unknown>(
  ctx: InvocationContext,
  nodeOrFunc: BaseNode<TInput, TOutput> | FunctionNodeHandler<TInput, TOutput>,
  input?: TInput,
  options?: RunNodeOptions,
): Promise<TOutput> {
  const node =
    typeof nodeOrFunc === 'function'
      ? new FunctionNode('run_node_dynamic', nodeOrFunc)
      : nodeOrFunc;

  const agentStates = getOrInitAgentStates(ctx);
  const execId =
    options?.customExecutionId ??
    `exec_node_${ctx.branch ? ctx.branch + '.' : ''}${node.name}`;

  const existingState = agentStates[execId] as NodeState | undefined;
  if (
    existingState &&
    isNodeState(existingState) &&
    existingState.status === NodeStatus.COMPLETED &&
    !node.rerunOnResume
  ) {
    return existingState.outputPayload as TOutput;
  }

  const stateRecord: NodeState = {
    executionId: execId,
    nodeName: node.name,
    status: NodeStatus.RUNNING,
    inputPayload: input,
    timestamp: Date.now(),
  };
  agentStates[execId] = stateRecord;

  try {
    const generator = node.run(ctx, input);
    const {output, isPausedHitl} = await consumeGenerator(generator);

    if (isPausedHitl || ctx.endInvocation || ctx.abortSignal?.aborted) {
      stateRecord.status = NodeStatus.PAUSED_HITL;
      stateRecord.timestamp = Date.now();
      ctx.endInvocation = true;
      throw new Error(`Node "${node.name}" requested HITL pause.`);
    }

    const finalVal =
      output !== undefined
        ? output
        : (node.lastOutputPayload ?? stateRecord.lastOutputPayload ?? input);
    stateRecord.status = NodeStatus.COMPLETED;
    stateRecord.outputPayload = finalVal;
    stateRecord.timestamp = Date.now();
    return finalVal as TOutput;
  } catch (error: unknown) {
    stateRecord.status = NodeStatus.FAILED;
    stateRecord.errorMessage =
      error instanceof Error ? error.message : String(error);
    stateRecord.timestamp = Date.now();
    throw error;
  }
}
