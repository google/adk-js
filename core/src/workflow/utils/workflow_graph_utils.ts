/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthConfig} from '../../auth/auth_tool.js';
import {SchemaLike} from '../../utils/schema.js';
import {BaseNode, isBaseNode, START} from '../base_node.js';
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
 * Node types register a builder (via {@link registerNodeBuilder}) at module load
 * so the graph parser stays decoupled from the concrete node classes. This keeps
 * the engine core free of static imports of `FunctionNode`, `ToolNode`,
 * `LLMAgentWrapper`, etc. — importing the node module (directly or through the
 * public workflow barrel) is what makes its builder available.
 */
export interface NodeBuilder {
  /**
   * Stable, unique id for this builder (e.g. `'function'`, `'tool'`). Used to
   * key the registry so re-registering the same id replaces rather than
   * duplicates — registration is idempotent across double module loads.
   */
  id: string;
  /**
   * Selection priority. Builders are consulted highest-priority first, with
   * registration order breaking ties. Make precedence explicit here rather than
   * relying on module import order (e.g. a tool builder must outrank an agent
   * builder that would also match a `BaseTool`). Defaults to 0.
   */
  priority?: number;
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

/**
 * The node-builder registry.
 *
 * This is intentionally process-global: the standard node modules self-register
 * their builders at import time, so any graph parsed in the process can build
 * any imported node type. There is deliberately no per-workflow scoping — all
 * workflows in a process share this one registry. Builders are keyed by
 * {@link NodeBuilder.id} so registration is idempotent (a double module load
 * replaces rather than accumulates), and consulted in a deterministic order
 * (see {@link orderedNodeBuilders}).
 */
const nodeBuilders = new Map<string, NodeBuilder>();
/** Registration sequence per builder id, for stable tie-breaking. */
const builderSequence = new Map<string, number>();
let registrationCounter = 0;
let parallelWorkerFactory: ParallelWorkerFactory | undefined;

/**
 * Registers a builder that converts a {@link NodeLike} value into a
 * {@link BaseNode}. Idempotent by {@link NodeBuilder.id}: re-registering the
 * same id replaces the previous builder rather than adding a duplicate.
 */
export function registerNodeBuilder(builder: NodeBuilder): void {
  if (!builder.id) {
    throw new Error('registerNodeBuilder: builder.id is required.');
  }
  if (!builderSequence.has(builder.id)) {
    builderSequence.set(builder.id, registrationCounter++);
  }
  nodeBuilders.set(builder.id, builder);
}

/** Builders in consultation order: highest priority first, then registration order. */
function orderedNodeBuilders(): NodeBuilder[] {
  return [...nodeBuilders.values()].sort((a, b) => {
    const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
    if (byPriority !== 0) {
      return byPriority;
    }
    return (builderSequence.get(a.id) ?? 0) - (builderSequence.get(b.id) ?? 0);
  });
}

/**
 * Registers the factory used to wrap a node in a parallel worker.
 *
 * Expected to be called at most once per process. Calling it again with the
 * same factory is a no-op; calling it with a *different* factory throws rather
 * than silently clobbering the existing one.
 */
export function registerParallelWorkerFactory(
  factory: ParallelWorkerFactory,
): void {
  if (parallelWorkerFactory && parallelWorkerFactory !== factory) {
    throw new Error(
      'registerParallelWorkerFactory: a different ParallelWorker factory is ' +
        'already registered. It must be registered at most once per process.',
    );
  }
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
    isBaseNode(value) ||
    [...nodeBuilders.values()].some((builder) => builder.match(value))
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
  if (isBaseNode(nodeLike)) {
    // TODO(phase-3+): apply property overrides via a clone when options differ.
    return nodeLike;
  }
  for (const builder of orderedNodeBuilders()) {
    if (builder.match(nodeLike)) {
      return builder.build(nodeLike, options);
    }
  }
  throw new Error(
    `build_node: unsupported node-like value of type ${typeof nodeLike}. ` +
      'Import the node module that handles it (e.g. via the workflow barrel).',
  );
}
