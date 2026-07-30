/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {experimental} from '../utils/experimental.js';

import {BaseNode, BaseNodeConfig} from './base_node.js';
import {NodeContext} from './node_context.js';

/**
 * A plain function usable as a workflow node.
 *
 * The function reports its result in one of two ways:
 *
 * - return a value — anything other than `undefined` or `null` becomes the
 *   node's output;
 * - be an async generator — every `Event` it yields is streamed to the caller,
 *   and it reports its result by assigning `ctx.output`.
 *
 * Either form may also assign `ctx.route` to steer the graph.
 */
export type NodeFunction = (ctx: NodeContext, nodeInput: unknown) => unknown;

/**
 * The config of a {@link FunctionNode}.
 *
 * The constructor takes this with `name` optional, because a named function
 * supplies it.
 */
export interface FunctionNodeConfig extends BaseNodeConfig {
  /** The function to run when the node executes. */
  fn: NodeFunction;
}

/**
 * Narrows a function's return value to an event stream.
 *
 * An async generator function returns an object carrying
 * `Symbol.asyncIterator`, which is how a streaming node is told apart from one
 * that returns a plain result.
 */
function isEventStream(value: unknown): value is AsyncIterable<Event> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

/**
 * A node that runs a plain function.
 *
 * Unlike adk-python's `FunctionNode`, parameters are not bound by name:
 * TypeScript erases parameter names and types at runtime, so the contract is
 * the explicit `(ctx, nodeInput)` signature and a function reads session state
 * through `ctx.state`.
 */
@experimental
export class FunctionNode extends BaseNode<FunctionNodeConfig> {
  /** The wrapped function. */
  readonly fn: NodeFunction;

  constructor(config: Omit<FunctionNodeConfig, 'name'> & {name?: string}) {
    const name = config.name ?? config.fn.name;
    if (!name) {
      throw new Error(
        'FunctionNode must have a name. Provide `name` explicitly when the ' +
          'wrapped function is anonymous.',
      );
    }
    super({...config, name});
    this.fn = config.fn;
  }

  override async *run(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    const result = this.fn(ctx, nodeInput);
    if (isEventStream(result)) {
      yield* result;
      return;
    }
    const value = await result;
    if (value !== undefined && value !== null) {
      ctx.output = value;
    }
  }
}
