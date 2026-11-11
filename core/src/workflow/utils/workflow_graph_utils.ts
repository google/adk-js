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
import {prepareRetryConfig, RetryConfig} from '../retry_config.js';

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
  /** Runs the node's subtree in an isolated conversation scope. */
  isolationScope?: string | true;
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
 *
 * `retryConfig`/`timeout` are intentionally not forwarded to the wrapper: they
 * apply to the inner node (per item), so the two levels don't compose.
 */
export type ParallelWorkerFactory = (
  inner: BaseNode,
  options: {maxParallelWorkers?: number},
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
 * directly — an agent is one, so it goes into the graph as itself; every other
 * value is delegated to the registered {@link NodeBuilder}s (function →
 * `FunctionNode`, tool → `ToolNode`).
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
    // retryConfig/timeout are applied to the inner (built) node, not the
    // wrapper, so they aren't forwarded here (see ParallelWorkerFactory).
    return PARALLEL_WORKER_FACTORY(built, {
      maxParallelWorkers: options.maxParallelWorkers,
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
    return cloneWithOverrides(nodeLike, options);
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

/**
 * The {@link BuildNodeOptions} keys that name a property of `BaseNode`.
 *
 * Every key of `BuildNodeOptions` is either listed here or excluded for a
 * reason, because a key that is neither is silently dropped — the fault this
 * function exists to remove. `satisfies` checks the entries that are listed,
 * not that the list is complete, so a new overridable `BaseNode` property must
 * be added here by hand.
 *
 * Excluded: `parallelWorker` and `maxParallelWorkers`, which describe the
 * wrapper {@link buildNode} puts *around* the node rather than the node itself;
 * and `authConfig`, which is not a `BaseNode` property (see
 * {@link NODE_DECLARED_KEYS}).
 */
const OVERRIDABLE_KEYS = [
  'name',
  'description',
  'rerunOnResume',
  'retryConfig',
  'timeout',
  'inputSchema',
  'outputSchema',
  'stateSchema',
  'isolationScope',
] as const satisfies ReadonlyArray<keyof BuildNodeOptions & keyof BaseNode>;

/**
 * {@link BuildNodeOptions} keys that no `BaseNode` declares but a concrete node
 * class does, applied only to a node that declares the property.
 *
 * `authConfig` is the only one: the function builder forwards it to
 * `FunctionNode`, which reads `this.authConfig` on every run to gate on
 * credentials, while the tool and agent builders ignore it. Guarding on the
 * property keeps this path consistent with a fresh build — the option reaches
 * the node that consumes it and no other.
 */
const NODE_DECLARED_KEYS = ['authConfig'] as const satisfies ReadonlyArray<
  Exclude<keyof BuildNodeOptions, keyof BaseNode>
>;

/**
 * Returns a copy of `node` with the given node properties replaced, or `node`
 * itself when nothing is being overridden.
 *
 * A node that was built before it reached the graph — `node(existingNode,
 * {timeout: 5})`, or a `Workflow` reused in two graphs with different retry
 * policies — cannot have its properties assigned in place: nodes are shared,
 * and mutating one would reach through to every graph holding it. adk-python
 * copies instead (`model_copy(update=...)`); this is the same move.
 *
 * The copy keeps the node's prototype, so its behaviour and its class are
 * unchanged, and carries over own properties including the `BaseNode` brand.
 * `preparedRetryConfig` is derived from `retryConfig` at construction, so it is
 * recomputed rather than copied — otherwise overriding the retry policy would
 * appear to work while the node kept retrying on the old one.
 *
 * **The copy is shallow**, so any mutable value a node holds stays shared with
 * the original. `FunctionNode`, `Workflow` and `ParallelWorker` hold only their
 * config and immutable per-run maps keyed by context, so nothing is shared that
 * matters. An agent does hold mutable lists (`tools`, `subAgents`), and shares
 * them with its copy — which is why this stays a copy of last resort, taken
 * only when an override is actually given. `BaseAgent.clone` is the real clone
 * seam (#534), but it detaches the agent from its parent, and a graph node that
 * silently left the agent tree could no longer be a `transfer_to_agent` target.
 * adk-python hits the same problem and patches around it, re-assigning
 * `parent_agent` onto the clone.
 */
function cloneWithOverrides(
  node: BaseNode,
  options: BuildNodeOptions,
): BaseNode {
  const overrides: Record<string, unknown> = {};
  for (const key of OVERRIDABLE_KEYS) {
    if (options[key] !== undefined) {
      overrides[key] = options[key];
    }
  }
  for (const key of NODE_DECLARED_KEYS) {
    if (options[key] !== undefined && key in node) {
      overrides[key] = options[key];
    }
  }
  if (Object.keys(overrides).length === 0) {
    // Identity matters: callers compare the node they passed in against the one
    // the graph holds.
    return node;
  }

  if (typeof overrides['name'] === 'string') {
    const name = overrides['name'].trim();
    if (!name) {
      throw new Error('Node name must be a non-empty string.');
    }
    overrides['name'] = name;
  }

  const clone = Object.create(
    Object.getPrototypeOf(node) as object,
  ) as BaseNode;
  Object.assign(clone, node, overrides);
  if ('retryConfig' in overrides) {
    Object.assign(clone, {
      preparedRetryConfig: options.retryConfig
        ? prepareRetryConfig(options.retryConfig)
        : undefined,
    });
  }
  return clone;
}
