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
 * The barrier itself is enforced by the orchestrator (which reads
 * `requiresAllPredecessors`) and lands in a later part.
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
