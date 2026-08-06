/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthConfig} from '../../auth/auth_tool.js';
import {SchemaLike} from '../../utils/schema.js';
import {BaseNode, isBaseNode, START} from '../base_node.js';
import {NodeLike} from '../graph.js';
import {NODE_BUILDERS, PARALLEL_WORKER_FACTORY} from '../node_builders.js';
import {RetryConfig} from '../retry_config.js';

/**
 * Property overrides applied when building a node from a {@link NodeLike}.
 */
export interface BuildNodeOptions {
  name?: string;
  description?: string;
  rerunOnResume?: boolean;
  retryConfig?: RetryConfig;
  timeout?: number;
  inputSchema?: SchemaLike;
  outputSchema?: SchemaLike;
  stateSchema?: SchemaLike;
  authConfig?: AuthConfig;
  /** If true, wrap the built node in a parallel worker. */
  parallelWorker?: boolean;
  /** Concurrency limit for the parallel worker (requires `parallelWorker`). */
  maxParallelWorkers?: number;
}

/**
 * Converts a matched {@link NodeLike} value into a concrete {@link BaseNode}.
 *
 * Builders are wired into the static {@link NODE_BUILDERS} list (in
 * `node_builders.ts`) and consulted by {@link buildNode} / {@link isNodeLike} in
 * order — first match wins. Keeping them in one explicit list (rather than a
 * runtime registry) means no global mutable state and no import-order side
 * effects: `node_builders.ts` imports the concrete node modules, and the engine
 * core imports that one list.
 */
export interface NodeBuilder {
  /** Returns whether this builder can convert `value` into a node. */
  match(value: unknown): boolean;
  /** Builds a node from a value this builder previously matched. */
  build(value: NodeLike, options: BuildNodeOptions): BaseNode;
}

/**
 * Wraps an already-built node in a parallel worker. Provided by the
 * `parallel_worker` node module via {@link PARALLEL_WORKER_FACTORY}.
 */
export type ParallelWorkerFactory = (
  inner: BaseNode,
  options: {
    maxParallelWorkers?: number;
    retryConfig?: RetryConfig;
    timeout?: number;
  },
) => BaseNode;

/**
 * Returns whether a value is a plain object literal (a `RoutingMap`) rather than
 * a class instance such as a node/tool/agent.
 */
export function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns whether a value can be converted into a workflow node via
 * {@link buildNode}: the `'START'` sentinel, an existing {@link BaseNode}, or a
 * value matched by a registered {@link NodeBuilder}.
 */
export function isNodeLike(value: unknown): value is NodeLike {
  return (
    value === 'START' ||
    isBaseNode(value) ||
    NODE_BUILDERS.some((builder) => builder.match(value))
  );
}

/**
 * Converts a {@link NodeLike} into a concrete {@link BaseNode}.
 *
 * Handles the `'START'` sentinel and existing {@link BaseNode} instances
 * directly; every other value is delegated to the registered
 * {@link NodeBuilder}s (function → `FunctionNode`, tool → `ToolNode`, agent →
 * `LLMAgentWrapper`, …).
 */
export function buildNode(
  nodeLike: NodeLike,
  options: BuildNodeOptions = {},
): BaseNode {
  if (options.maxParallelWorkers !== undefined && !options.parallelWorker) {
    throw new Error(
      'maxParallelWorkers can only be set when parallelWorker is true.',
    );
  }

  const built = buildInnerNode(nodeLike, options);

  if (options.parallelWorker) {
    if (nodeLike === 'START') {
      throw new Error('ParallelWorker cannot wrap a START node.');
    }
    if (!PARALLEL_WORKER_FACTORY) {
      throw new Error(
        'parallelWorker was requested but no ParallelWorker is available; ' +
          'the parallel worker node module is not part of this build.',
      );
    }
    return PARALLEL_WORKER_FACTORY(built, {
      maxParallelWorkers: options.maxParallelWorkers,
      retryConfig: options.retryConfig,
      timeout: options.timeout,
    });
  }
  return built;
}

function buildInnerNode(
  nodeLike: NodeLike,
  options: BuildNodeOptions,
): BaseNode {
  if (nodeLike === 'START') {
    return START;
  }
  if (isBaseNode(nodeLike)) {
    // TODO(phase-3+): apply property overrides via a clone when options differ.
    return nodeLike;
  }
  for (const builder of NODE_BUILDERS) {
    if (builder.match(nodeLike)) {
      return builder.build(nodeLike, options);
    }
  }
  throw new Error(
    `build_node: unsupported node-like value of type ${typeof nodeLike}. ` +
      'Import the node module that handles it (e.g. via the workflow barrel).',
  );
}
