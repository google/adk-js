/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseNode, BaseNodeConfig, START} from './base_node.js';
import {FunctionNode, NodeFunction} from './function_node.js';

/**
 * Anything that can be used where a workflow node is expected: a node, a
 * function to wrap as a node, or the literal `'START'`.
 */
export type NodeLike = BaseNode | NodeFunction | 'START';

/** Config fields that can be overridden when building a node. */
export type NodeOptions = Partial<BaseNodeConfig>;

/**
 * Builds a workflow node.
 *
 * ```ts
 * const classify = node(async (ctx) => {
 *   ctx.route = ctx.state.get<number>('score', 0)! > 5 ? 'high' : 'low';
 * });
 * const slow = node(callApi, {name: 'callApi', timeoutMs: 5_000});
 * ```
 *
 * A function becomes a {@link FunctionNode}. An existing node is returned
 * unchanged when there is nothing to override, so a node referenced several
 * times in an edge list stays one graph node. `'START'` resolves to the shared
 * {@link START} sentinel and ignores `options`, which a sentinel cannot carry.
 *
 * adk-python's `node` doubles as a decorator; TypeScript decorators cannot be
 * applied to plain functions, so only this factory form exists.
 *
 * @param nodeLike The node, function or `'START'` to build a node from.
 * @param options Config fields to override on the built node.
 * @returns The built node.
 */
export function node(nodeLike: NodeLike, options: NodeOptions = {}): BaseNode {
  if (nodeLike === 'START') {
    return START;
  }
  if (nodeLike instanceof BaseNode) {
    return Object.keys(options).length > 0 ? nodeLike.clone(options) : nodeLike;
  }
  return new FunctionNode({...options, fn: nodeLike});
}
