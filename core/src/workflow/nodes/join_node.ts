/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../../agents/invocation_context.js';
import {createEvent, Event} from '../../events/event.js';
import {BaseNode, BaseNodeOptions} from '../base_node.js';
import {getOrInitAgentStates} from '../node_runner.js';
import {isNodeState, NodeStatus} from '../node_state.js';

/**
 * Options for configuring a JoinNode.
 */
export interface JoinNodeOptions extends BaseNodeOptions {
  /**
   * The number of distinct upstream predecessor nodes that must complete
   * before this join node unblocks and emits a combined output.
   * Must be >= 1.
   */
  upstreamCount: number;

  /**
   * Optional array of explicit predecessor node names to wait on.
   * If provided, `upstreamCount` must match `predecessors.length`.
   */
  predecessors?: string[];
}

/**
 * A synchronization barrier node used in fan-out/fan-in parallel workflows.
 * Waits until `upstreamCount` predecessor branches have reached completion (`COMPLETED`),
 * then aggregates their outputs into a dictionary and yields a single combined event.
 */
export class JoinNode<
  TInput = unknown,
  TOutput = Record<string, unknown>,
> extends BaseNode<TInput, TOutput> {
  readonly upstreamCount: number;
  readonly predecessors?: string[];

  constructor(name: string, options: JoinNodeOptions) {
    if (
      !options ||
      typeof options.upstreamCount !== 'number' ||
      options.upstreamCount < 1
    ) {
      throw new Error(
        `JoinNode "${name}" requires a valid upstreamCount >= 1.`,
      );
    }
    if (
      options.predecessors &&
      options.predecessors.length !== options.upstreamCount
    ) {
      throw new Error(
        `JoinNode "${name}" upstreamCount (${options.upstreamCount}) does not match predecessors.length (${options.predecessors.length}).`,
      );
    }
    super(name, options);
    this.upstreamCount = options.upstreamCount;
    this.predecessors = options.predecessors;
  }

  /**
   * Evaluates the completion status of upstream predecessor nodes in `InvocationContext.agentStates`.
   * Only unblocks and yields combined output when all required predecessors have completed.
   */
  async *run(
    ctx: InvocationContext,
    _input?: TInput,
  ): AsyncGenerator<Event, TOutput, unknown> {
    const agentStates = getOrInitAgentStates(ctx);

    const completedPredecessors: Record<string, unknown> = {};
    let count = 0;

    if (this.predecessors && this.predecessors.length > 0) {
      for (const predName of this.predecessors) {
        for (const state of Object.values(agentStates)) {
          if (
            isNodeState(state) &&
            state.nodeName === predName &&
            state.status === NodeStatus.COMPLETED
          ) {
            completedPredecessors[predName] = state.outputPayload;
            count++;
            break;
          }
        }
      }
    } else {
      for (const state of Object.values(agentStates)) {
        if (
          isNodeState(state) &&
          state.nodeName !== this.name &&
          state.status === NodeStatus.COMPLETED &&
          !(state.nodeName in completedPredecessors)
        ) {
          completedPredecessors[state.nodeName] = state.outputPayload;
          count++;
        }
      }
    }

    if (count < this.upstreamCount) {
      return completedPredecessors as unknown as TOutput;
    }

    const joinEvent = createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      actions: {
        joinCompleted: {
          node: this.name,
          upstreamCount: this.upstreamCount,
          predecessors: Object.keys(completedPredecessors),
          outputs: completedPredecessors,
        },
      },
    });

    yield joinEvent;
    this.lastOutputPayload = completedPredecessors;
    return completedPredecessors as unknown as TOutput;
  }
}
