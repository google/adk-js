/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {BaseNode} from './base_node.js';
import {NodeLike} from './graph.js';
import {NodeContext} from './node_context.js';
// Register the built-in node builders so node() works when imported directly.
import './register_builtin_nodes.js';
import {buildNode, BuildNodeOptions} from './utils/workflow_graph_utils.js';

/** Options accepted by {@link node}. */
export type NodeOptions = BuildNodeOptions;

/**
 * Wraps a {@link NodeLike} (function, tool, agent, or existing node) into a
 * {@link BaseNode}, optionally overriding its properties.
 *
 * The TypeScript form is a plain function (there is no `@node` decorator form,
 * unlike Python). Examples:
 *
 * ```ts
 * const a = node(myFunction, {name: 'classify'});
 * const b = node(myTool);
 * ```
 *
 * Ported from `google/adk-python` `workflow/_node.py::node`.
 */
export function node(nodeLike: NodeLike, options: NodeOptions = {}): BaseNode {
  return buildNode(nodeLike, options);
}

/**
 * A base class designed for subclassing. Implement {@link runNodeImpl} to
 * provide node logic; subclasses inherit the schema/retry/timeout machinery of
 * {@link BaseNode}.
 *
 * Mirrors `google/adk-python` `workflow/_node.py::Node`. The `parallel_worker`
 * capability is added in Phase 6.
 */
export abstract class Node<
  TInput = unknown,
  TOutput = unknown,
> extends BaseNode<TInput, TOutput> {
  /**
   * Implement node execution logic here. May yield `Event`s, raw values, or
   * `null` (normalized by {@link BaseNode.run}).
   */
  protected abstract runNodeImpl(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event | TOutput | unknown, void, void>;

  protected async *runImpl(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event | TOutput | unknown, void, void> {
    yield* this.runNodeImpl(ctx, input);
  }
}
