/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {experimental} from '../utils/experimental.js';

import {BaseNode} from './base_node.js';
import {NodeContext} from './node_context.js';

/**
 * A fan-in node: it runs once every predecessor has completed and outputs
 * their outputs as a record keyed by predecessor name.
 */
@experimental
export class JoinNode extends BaseNode {
  override get requiresAllPredecessors(): boolean {
    return true;
  }

  override async *run(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    ctx.output = nodeInput;
    // A join emits nothing of its own; delegating to an empty stream keeps
    // this an async generator without suppressing the require-yield rule.
    yield* [];
  }
}
