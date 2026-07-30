/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';

import type {BaseNode} from './base_node.js';
import type {RouteValue} from './route.js';

/**
 * The parameters for creating a {@link NodeContext}.
 */
export interface NodeContextConfig {
  /** The invocation this node run belongs to. */
  invocationContext: InvocationContext;

  /** The node being run. */
  node: BaseNode;

  /** Identifier of this run of the node, unique per node per workflow run. */
  runId: string;

  /** 1-based attempt number of this run. Defaults to 1. */
  attemptCount?: number;

  /** The `nodePath` of the node that scheduled this run, when nested. */
  parentNodePath?: string;
}

/**
 * The context of a single node run.
 *
 * Extends the agent {@link Context}, so a node gets the same delta-aware
 * `state`, `actions`, `abortSignal`, artifact and memory helpers an agent
 * callback or a tool gets.
 *
 * A node reports its result by assigning {@link NodeContext.output} and
 * {@link NodeContext.route}; `adk-js` events carry neither field, so the
 * context is the single source of truth for both.
 */
export class NodeContext extends Context {
  /** The node this context belongs to. */
  readonly node: BaseNode;

  /** Identifier of this run of the node. */
  readonly runId: string;

  /** 1-based attempt number of this run. */
  readonly attemptCount: number;

  /**
   * The location of this run in the node tree: `<name>@<runId>` at the root,
   * `<parentNodePath>/<name>@<runId>` inside a nested workflow.
   */
  readonly nodePath: string;

  /**
   * The node's result. `undefined` means the node produced no output.
   */
  output: unknown;

  /**
   * The route(s) the node emitted, used to select its outgoing edges.
   */
  route?: RouteValue | RouteValue[];

  constructor(config: NodeContextConfig) {
    super({invocationContext: config.invocationContext});
    this.node = config.node;
    this.runId = config.runId;
    this.attemptCount = config.attemptCount ?? 1;
    const segment = `${config.node.name}@${config.runId}`;
    this.nodePath = config.parentNodePath
      ? `${config.parentNodePath}/${segment}`
      : segment;
  }
}
