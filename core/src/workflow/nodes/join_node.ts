/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../../events/event.js';
import {BaseNode} from '../base_node.js';
import {NodeContext} from '../node_context.js';

/**
 * A fan-in barrier node: it waits for ALL of its predecessors to complete, then
 * emits the aggregated inputs (a map of predecessor name → output) as its
 * output.
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
