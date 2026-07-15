/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../../agents/invocation_context.js';
import {createEvent, Event} from '../../events/event.js';
import {BaseNode} from '../base_node.js';
import {generateExecutionId, getOrInitAgentStates} from '../node_runner.js';
import {isNodeState, NodeState, NodeStatus} from '../node_state.js';

/**
 * Manages event replay when a workflow node is bypassed due to a completed historical checkpoint (`rerunOnResume == false`).
 * Yields historical events associated with that node execution so client UIs and event subscribers can reconstruct the full trajectory.
 */
export class ReplayManager {
  /**
   * Checks if the given node has a historical COMPLETED checkpoint in `InvocationContext.agentStates`
   * and yields its historical events (or a synthetic replay event) if `!node.rerunOnResume`.
   *
   * @param ctx The current invocation context.
   * @param node The node being checked for replay.
   * @yields Historical or synthetic replay events if checkpoint exists.
   * @returns True if the node was successfully replayed (and execution should be skipped), false otherwise.
   */
  static async *replayIfCompleted(
    ctx: InvocationContext,
    node: BaseNode,
  ): AsyncGenerator<Event, boolean, unknown> {
    if (node.rerunOnResume) {
      return false;
    }

    const agentStates = getOrInitAgentStates(ctx);
    const execId = generateExecutionId(ctx, node.name);
    const existingState = agentStates[execId] as NodeState | undefined;

    if (
      existingState &&
      isNodeState(existingState) &&
      existingState.status === NodeStatus.COMPLETED
    ) {
      if (Array.isArray(existingState.cachedEvents)) {
        for (const event of existingState.cachedEvents) {
          yield event;
        }
      } else if (existingState.outputPayload !== undefined) {
        yield createEvent({
          invocationId: ctx.invocationId,
          author: node.name,
          branch: ctx.branch,
          actions: {
            nodeExecutionReplay: {
              executionId: execId,
              nodeName: node.name,
              outputPayload: existingState.outputPayload,
              timestamp: existingState.timestamp,
            },
          },
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Caches emitted events onto a node's state record during live execution so they can be replayed on subsequent resumptions.
   *
   * @param ctx The invocation context.
   * @param execId The execution ID of the running node.
   * @param event The emitted event to cache.
   */
  static cacheEventForReplay(
    ctx: InvocationContext,
    execId: string,
    event: Event,
  ): void {
    const agentStates = getOrInitAgentStates(ctx);
    const state = agentStates[execId] as NodeState | undefined;
    if (state && isNodeState(state)) {
      if (!Array.isArray(state.cachedEvents)) {
        state.cachedEvents = [];
      }
      state.cachedEvents.push(event);
    }
  }
}
