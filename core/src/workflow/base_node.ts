/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

import {NodeContext} from './node_context.js';
import {RetryConfig} from './retry_config.js';

/** Node names must be valid JavaScript identifiers. */
const NODE_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The parameters shared by every workflow node.
 */
export interface BaseNodeConfig {
  /** The node's name, unique within a graph and a valid JS identifier. */
  name: string;

  /**
   * If true, the node completes only once it produces an output or a route.
   *
   * Until then it stays pending and its downstream nodes are not triggered,
   * so its predecessors can run it again — once per queued input, one input
   * at a time — until it decides. This is the general form of a barrier;
   * JoinNode covers the common "wait for every predecessor" case
   * declaratively.
   *
   * A node that declares this and never produces an output or a route
   * deadlocks its branch; that is a configuration error.
   */
  waitForOutput?: boolean;

  /** How to retry this node when it throws. No retries when omitted. */
  retryConfig?: RetryConfig;

  /** Maximum time for one run of this node, in milliseconds. */
  timeoutMs?: number;
}

/**
 * The contract every node in a workflow graph implements.
 *
 * Subclass it and implement {@link BaseNode.run} to add a node type; wrap a
 * plain function with `node(fn)` for the common case.
 *
 * The class is generic over its config type so {@link BaseNode.clone} stays
 * typed per subclass, matching `BaseAgent`.
 *
 * The whole `workflow` module is experimental. The `@experimental` decorator
 * is applied only to the classes a caller names that the framework does not
 * also build on its own: decorating `BaseNode` would warn on merely importing
 * `@google/adk`, because the {@link START} sentinel is built at module load,
 * and decorating `Graph` or `NodeContext` would warn on every workflow run.
 */
export abstract class BaseNode<
  TConfig extends BaseNodeConfig = BaseNodeConfig,
> {
  /**
   * The config this node was constructed from.
   *
   * Stored so {@link clone} can rebuild the node by re-running the concrete
   * constructor with overrides applied, which re-derives all state instead of
   * copying an already-built instance.
   */
  protected readonly config: TConfig;

  /** The node's name, unique within a graph. */
  readonly name: string;

  /** See {@link BaseNodeConfig.waitForOutput}. */
  readonly waitForOutput: boolean;

  /** See {@link BaseNodeConfig.retryConfig}. */
  readonly retryConfig?: RetryConfig;

  /** See {@link BaseNodeConfig.timeoutMs}. */
  readonly timeoutMs?: number;

  constructor(config: TConfig) {
    if (!NODE_NAME_PATTERN.test(config.name)) {
      throw new Error(`Node name '${config.name}' must be a valid identifier.`);
    }
    // Copied so later mutation of the caller's object cannot leak into clones.
    this.config = {...config};
    this.name = config.name;
    this.waitForOutput = config.waitForOutput ?? false;
    this.retryConfig = config.retryConfig;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Runs the node.
   *
   * @param ctx The context of this node run. The node reports its result by
   *     assigning `ctx.output` and/or `ctx.route`.
   * @param nodeInput The output of the upstream node, or the workflow's own
   *     input for a node wired directly to `START`.
   * @yields The events the node emits while it runs.
   */
  abstract run(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void>;

  /**
   * If true, the node runs only once every predecessor has completed, and
   * receives a record of their outputs keyed by predecessor name.
   */
  get requiresAllPredecessors(): boolean {
    return false;
  }

  /**
   * Creates a copy of this node with the given config fields overridden.
   *
   * @param overrides Config fields to override on the copy.
   * @returns A new node of the same concrete class.
   */
  clone(overrides?: Partial<TConfig>): this {
    const ctor = this.constructor as new (config: TConfig) => this;
    return new ctor({...this.config, ...overrides});
  }
}

/** The node behind {@link START}: a marker that refuses to run. */
class StartNode extends BaseNode {
  // Deliberately not a generator: START is never executed, so it rejects the
  // call itself instead of waiting to be iterated.
  run(): AsyncGenerator<Event, void, void> {
    throw new Error('START marks a graph entry point and is never executed.');
  }
}

/**
 * The sentinel node marking the entry point of a workflow graph.
 *
 * Edges out of `START` carry no route and fire with the workflow's own input;
 * `START` itself has no incoming edges and is never executed.
 */
export const START: BaseNode = new StartNode({name: '__START__'});
