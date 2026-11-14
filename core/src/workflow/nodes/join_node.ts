/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../../events/event.js';
import {BaseNode} from '../base_node.js';
import {NodeContext} from '../node_context.js';

/**
 * A fan-in barrier node: via {@link requiresAllPredecessors} the engine holds it
 * until ALL of its predecessors complete, then runs it with their aggregated
 * outputs as input.
 *
 * This node emits that input unchanged — the engine supplies the
 * predecessor-name → output map; the join just passes it through as its output.
 * The barrier itself is enforced by the orchestrator, which reads
 * `requiresAllPredecessors`.
 *
 * In a loop, each firing waits for the predecessors inside the loop to run
 * again: those the join can reach by following edges, including routes the run
 * never takes. A predecessor the join cannot reach, such as a setup step that
 * runs once before the loop starts, keeps counting in later iterations, and the
 * join receives its latest output. Because every edge counts, a step of an
 * outer loop around the join's loop, or a setup step the loop can route back
 * to, counts as inside the loop too; if such a step feeds the join, the join
 * fires only in the first iteration. A join after a loop, not on it, fires
 * once.
 *
 * A predecessor that routes away from the join never arrives, so the join does
 * not fire. If the loop restarts before the join fires, the arrivals already
 * recorded carry over, and the next firing can combine outputs from different
 * iterations.
 *
 * Ported from `google/adk-python` `workflow/_join_node.py`.
 */
export class JoinNode extends BaseNode {
  override get requiresAllPredecessors(): boolean {
    return true;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      output: input,
    });
  }
}
