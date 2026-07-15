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
 * Options for configuring parallel branch execution (`runInParallel`).
 */
export interface ParallelRunOptions {
  /**
   * Optional prefix for naming the child branches in `InvocationContext.branch`.
   * Defaults to the target node name.
   */
  branchPrefix?: string;

  /**
   * If true, throws an error immediately if any parallel worker branch fails.
   * If false, catches branch errors and returns undefined/error markers for failed items.
   * Default is true.
   */
  stopOnError?: boolean;
}

/**
 * Executes a target node (or function) concurrently across an array of input items using isolated
 * child `InvocationContext` branches. Prevents concurrent async tasks from corrupting shared
 * session event histories or racing on shared node state checkpoints.
 *
 * @param ctx The parent invocation context.
 * @param nodeOrFunc The BaseNode or function handler to execute for each item.
 * @param items Array of input items to process in parallel.
 * @param options Optional settings (branchPrefix, stopOnError).
 * @returns Promise resolving to an array of output payloads corresponding 1-to-1 with the items array.
 */
export async function runInParallel<TInput = unknown, TOutput = unknown>(
  ctx: InvocationContext,
  nodeOrFunc: BaseNode<TInput, TOutput> | FunctionNodeHandler<TInput, TOutput>,
  items: TInput[],
  options?: ParallelRunOptions,
): Promise<TOutput[]> {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const node =
    typeof nodeOrFunc === 'function'
      ? new FunctionNode('parallel_worker_node', nodeOrFunc)
      : nodeOrFunc;

  const prefix = options?.branchPrefix || node.name;
  const stopOnError = options?.stopOnError ?? true;
  const parentStates = getOrInitAgentStates(ctx);

  const tasks = items.map(async (item, index) => {
    const branchName = ctx.branch
      ? `${ctx.branch}.${prefix}_${index}`
      : `${prefix}_${index}`;

    const childCtx = new InvocationContext({
      ...ctx,
      branch: branchName,
    });

    const childStates: Record<string, unknown> = {...parentStates};
    (childCtx as unknown as Record<string, unknown>).agentStates = childStates;

    const execId = `exec_node_${branchName}.${node.name}`;

    const existingState = childStates[execId] as NodeState | undefined;
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
      nodeName: `${node.name}_${index}`,
      status: NodeStatus.RUNNING,
      inputPayload: item,
      timestamp: Date.now(),
    };
    childStates[execId] = stateRecord;

    try {
      const generator = node.run(childCtx, item);
      const {output, isPausedHitl} = await consumeGenerator(generator);

      if (isPausedHitl || ctx.endInvocation || ctx.abortSignal?.aborted) {
        stateRecord.status = NodeStatus.PAUSED_HITL;
        stateRecord.timestamp = Date.now();
        ctx.endInvocation = true;
        throw new Error(
          `Parallel worker branch "${branchName}" requested HITL pause.`,
        );
      }

      const finalVal =
        output !== undefined
          ? output
          : (node.lastOutputPayload ?? stateRecord.lastOutputPayload ?? item);
      stateRecord.status = NodeStatus.COMPLETED;
      stateRecord.outputPayload = finalVal;
      stateRecord.timestamp = Date.now();

      parentStates[execId] = stateRecord;
      return finalVal as TOutput;
    } catch (err: unknown) {
      stateRecord.status = NodeStatus.FAILED;
      stateRecord.errorMessage =
        err instanceof Error ? err.message : String(err);
      stateRecord.timestamp = Date.now();
      parentStates[execId] = stateRecord;
      if (stopOnError) {
        throw err;
      }
      return undefined as unknown as TOutput;
    }
  });

  return await Promise.all(tasks);
}
