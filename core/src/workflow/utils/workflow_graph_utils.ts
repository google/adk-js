/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ZodType} from 'zod';
import {AuthConfig} from '../../auth/auth_tool.js';
import {BaseNode, START} from '../base_node.js';
import {NodeLike} from '../graph.js';
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
  inputSchema?: ZodType;
  outputSchema?: ZodType;
  stateSchema?: ZodType;
  authConfig?: AuthConfig;
  /** If true, wrap the built node in a parallel worker. */
  parallelWorker?: boolean;
  /** Concurrency limit for the parallel worker (requires `parallelWorker`). */
  maxParallelWorkers?: number;
}

/**
 * Converts a matched {@link NodeLike} value into a concrete {@link BaseNode}.
 *
 * Node types register a builder (via {@link registerNodeBuilder}) at module load
 * so the graph parser stays decoupled from the concrete node classes. This keeps
 * the engine core free of static imports of `FunctionNode`, `ToolNode`,
 * `LLMAgentWrapper`, etc. — importing the node module (directly or through the
 * public workflow barrel) is what makes its builder available.
 */
export interface NodeBuilder {
  /** Returns whether this builder can convert `value` into a node. */
  match(value: unknown): boolean;
  /** Builds a node from a value this builder previously matched. */
  build(value: NodeLike, options: BuildNodeOptions): BaseNode;
}

/**
 * Wraps an already-built node in a parallel worker. Registered by the
 * `parallel_worker` node module (via {@link registerParallelWorkerFactory}).
 */
export type ParallelWorkerFactory = (
  inner: BaseNode,
  options: {
    maxParallelWorkers?: number;
    retryConfig?: RetryConfig;
    timeout?: number;
  },
) => BaseNode;

const nodeBuilders: NodeBuilder[] = [];
let parallelWorkerFactory: ParallelWorkerFactory | undefined;

/**
 * Registers a builder that converts a {@link NodeLike} value into a
 * {@link BaseNode}. Builders are consulted in registration order; the first
 * whose {@link NodeBuilder.match} returns true wins.
 */
export function registerNodeBuilder(builder: NodeBuilder): void {
  nodeBuilders.push(builder);
}

/** Registers the factory used to wrap a node in a parallel worker. */
export function registerParallelWorkerFactory(
  factory: ParallelWorkerFactory,
): void {
  parallelWorkerFactory = factory;
}

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
    value instanceof BaseNode ||
    nodeBuilders.some((builder) => builder.match(value))
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
    if (!parallelWorkerFactory) {
      throw new Error(
        'parallelWorker was requested but no ParallelWorker is registered; ' +
          'import the parallel worker node module to enable it.',
      );
    }
    return parallelWorkerFactory(built, {
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
  if (nodeLike instanceof BaseNode) {
    // TODO(phase-3+): apply property overrides via a clone when options differ.
    return nodeLike;
  }
  for (const builder of nodeBuilders) {
    if (builder.match(nodeLike)) {
      return builder.build(nodeLike, options);
    }
  }
  throw new Error(
    `build_node: unsupported node-like value of type ${typeof nodeLike}. ` +
      'Import the node module that handles it (e.g. via the workflow barrel).',
  );
}
