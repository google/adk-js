/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ZodType} from 'zod';
import {BaseAgent, isBaseAgent} from '../../agents/base_agent.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {BaseTool, isBaseTool} from '../../tools/base_tool.js';
import {BaseNode, START} from '../base_node.js';
import {NodeLike} from '../graph.js';
import {FunctionNode, FunctionNodeHandler} from '../nodes/function_node.js';
import {LLMAgentWrapper} from '../nodes/llm_agent_wrapper.js';
import {ParallelWorker} from '../nodes/parallel_worker.js';
import {ToolNode} from '../nodes/tool_node.js';
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
  /** If true, wrap the built node in a {@link ParallelWorker}. */
  parallelWorker?: boolean;
  /** Concurrency limit for the parallel worker (requires `parallelWorker`). */
  maxParallelWorkers?: number;
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
 * {@link buildNode}.
 */
export function isNodeLike(value: unknown): value is NodeLike {
  return (
    value === 'START' ||
    value instanceof BaseNode ||
    isBaseTool(value) ||
    typeof value === 'function' ||
    isAgentLike(value)
  );
}

/**
 * Converts a {@link NodeLike} into a concrete {@link BaseNode}.
 *
 * Supported now: the `'START'` sentinel, existing {@link BaseNode} instances,
 * plain functions (→ {@link FunctionNode}), and {@link BaseTool}s (→
 * {@link ToolNode}). Wrapping agents (`LlmAgent`) lands in Phase 7.
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
    return new ParallelWorker(built, {
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
  if (isBaseTool(nodeLike)) {
    return new ToolNode(nodeLike as BaseTool, options);
  }
  if (typeof nodeLike === 'function') {
    const name = options.name ?? (nodeLike as {name?: string}).name;
    if (!name) {
      throw new Error(
        'node(): the wrapped function has no name; pass {name} explicitly.',
      );
    }
    return new FunctionNode(name, nodeLike as FunctionNodeHandler, options);
  }
  if (isBaseAgent(nodeLike) || isAgentLike(nodeLike)) {
    return new LLMAgentWrapper(nodeLike as BaseAgent, options);
  }
  throw new Error(
    `build_node: unsupported node-like value of type ${typeof nodeLike}.`,
  );
}

/** Heuristic: an agent-like value exposes a `runAsync` generator method. */
function isAgentLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runAsync' in value &&
    typeof (value as {runAsync?: unknown}).runAsync === 'function'
  );
}
