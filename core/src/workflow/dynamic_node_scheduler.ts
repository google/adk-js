/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {Event, isEvent} from '../events/event.js';
import {BaseNode} from './base_node.js';
import {
  consumeGenerator,
  generateExecutionId,
  getOrInitAgentStates,
} from './node_runner.js';
import {NodeState, NodeStatus, isNodeState} from './node_state.js';
import {FunctionNode, FunctionNodeHandler} from './nodes/function_node.js';

/**
 * Type for the dynamic workflow entry point.
 */
export type DynamicEntryFunction<
  TInput = unknown,
  TOutput = unknown,
> = FunctionNodeHandler<TInput, TOutput>;

export type DynamicEntry<TInput = unknown, TOutput = unknown> =
  | BaseNode<TInput, TOutput>
  | DynamicEntryFunction<TInput, TOutput>;

/**
 * Options for the DynamicNodeScheduler.
 */
export interface DynamicNodeSchedulerOptions {
  /**
   * Key inside `InvocationContext.agentStates` where the final output of the
   * dynamic entry point should be saved upon completion.
   */
  outputKey?: string;
}

/**
 * Coordinates and executes a dynamic workflow where control flow (`async/await`, loops, conditionals)
 * is driven programmatically by Python/TS code calling `ctx.runNode(...)`.
 * Manages deterministic ID counters (`exec_node_<workflow>_<counter>`) and checkpoint skip-on-resume.
 */
export class DynamicNodeScheduler {
  readonly entryNode: BaseNode;
  readonly options: DynamicNodeSchedulerOptions;

  /**
   * @param entry A BaseNode instance or a function handler to serve as the root of the dynamic workflow.
   * @param options Optional configuration (outputKey).
   */
  constructor(entry: DynamicEntry, options?: DynamicNodeSchedulerOptions) {
    if (typeof entry === 'function') {
      this.entryNode = new FunctionNode('dynamic_entry_node', entry);
    } else if (isBaseNode(entry)) {
      this.entryNode = entry;
    } else {
      throw new Error(
        'DynamicNodeScheduler requires a valid BaseNode instance or function handler.',
      );
    }
    this.options = options || {};
  }

  /**
   * Runs the dynamic workflow entry node, intercepting events and handling checkpointing.
   */
  async *runAsync(
    ctx: InvocationContext,
    initialInput?: unknown,
  ): AsyncGenerator<Event, void, void> {
    const agentStates = getOrInitAgentStates(ctx);
    const execId = generateExecutionId(ctx, this.entryNode.name);

    const existingState = agentStates[execId] as NodeState | undefined;
    if (
      existingState &&
      isNodeState(existingState) &&
      existingState.status === NodeStatus.COMPLETED &&
      !this.entryNode.rerunOnResume
    ) {
      if (this.options.outputKey) {
        agentStates[this.options.outputKey] = existingState.outputPayload;
      }
      return;
    }

    const stateRecord: NodeState = {
      executionId: execId,
      nodeName: this.entryNode.name,
      status: NodeStatus.RUNNING,
      inputPayload: initialInput,
      timestamp: Date.now(),
    };
    agentStates[execId] = stateRecord;

    try {
      const generator = this.entryNode.run(ctx, initialInput);
      const yieldedEvents: Event[] = [];

      const {output, isPausedHitl} = await consumeGenerator(
        generator,
        async (ev) => {
          if (isEvent(ev)) {
            yieldedEvents.push(ev);
          }
        },
      );

      for (const ev of yieldedEvents) {
        yield ev;
      }

      if (isPausedHitl || ctx.endInvocation || ctx.abortSignal?.aborted) {
        stateRecord.status = NodeStatus.PAUSED_HITL;
        stateRecord.timestamp = Date.now();
        ctx.endInvocation = true;
        return;
      }

      const finalResult =
        output !== undefined
          ? output
          : (this.entryNode.lastOutputPayload ??
            stateRecord.lastOutputPayload ??
            initialInput);
      stateRecord.status = NodeStatus.COMPLETED;
      stateRecord.outputPayload = finalResult;
      stateRecord.timestamp = Date.now();

      if (this.options.outputKey) {
        agentStates[this.options.outputKey] = finalResult;
      }
    } catch (error: unknown) {
      stateRecord.status = NodeStatus.FAILED;
      stateRecord.errorMessage =
        error instanceof Error ? error.message : String(error);
      stateRecord.timestamp = Date.now();
      throw error;
    }
  }
}

function isBaseNode(obj: unknown): obj is BaseNode {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    typeof (obj as BaseNode).name === 'string' &&
    'run' in obj &&
    typeof (obj as BaseNode).run === 'function'
  );
}
