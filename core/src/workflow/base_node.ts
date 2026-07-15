/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {RetryConfig, normalizeRetryConfig} from './retry_config.js';

/**
 * Options for configuring a BaseNode.
 */
export interface BaseNodeOptions {
  /**
   * If true, the node will re-execute when a workflow is resumed even if
   * historical completed state exists in `InvocationContext.agentStates`.
   * Default is false.
   */
  rerunOnResume?: boolean;

  /**
   * Optional retry configuration for handling transient errors during execution.
   */
  retryConfig?: RetryConfig;
}

/**
 * Abstract base class for all nodes in an ADK Workflow.
 * A node represents a discrete unit of execution within a static graph or dynamic chain.
 */
export abstract class BaseNode<TInput = unknown, TOutput = unknown> {
  /**
   * The canonical name of the node. Must be unique within a workflow graph.
   */
  readonly name: string;

  /**
   * Whether this node should re-execute when resuming a paused or rehydrated workflow.
   */
  readonly rerunOnResume: boolean;

  /**
   * The normalized retry configuration for this node, if any.
   */
  readonly retryConfig?: Required<RetryConfig>;

  /**
   * Optional cached output payload stored on the instance during generator execution.
   */
  lastOutputPayload?: unknown;

  constructor(name: string, options?: BaseNodeOptions) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Node name must be a non-empty string.');
    }
    this.name = name.trim();
    this.rerunOnResume = options?.rerunOnResume ?? false;
    this.retryConfig = normalizeRetryConfig(options?.retryConfig);
  }

  /**
   * Core execution contract for a node.
   *
   * @param ctx The invocation context of the current workflow execution.
   * @param input Optional input payload passed from upstream nodes or dynamic scheduler.
   * @yields Events generated during node execution (including partial output or route events).
   * @returns The final output payload of this node.
   */
  abstract run(
    ctx: InvocationContext,
    input?: TInput,
  ): AsyncGenerator<Event, TOutput, unknown>;
}
