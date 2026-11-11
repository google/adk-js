/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, isBaseTool} from '../tools/base_tool.js';
import {FunctionNode, FunctionNodeHandler} from './nodes/function_node.js';
import {ParallelWorker} from './nodes/parallel_worker.js';
import {ToolNode} from './nodes/tool_node.js';
import type {
  NodeBuilder,
  ParallelWorkerFactory,
} from './utils/workflow_graph_utils.js';

/** Builds a {@link FunctionNode} from a plain function. */
const FUNCTION_BUILDER: NodeBuilder = {
  match: (value) => typeof value === 'function',
  build: (value, options) => {
    const handler = value as FunctionNodeHandler;
    const name = options.name ?? (handler as {name?: string}).name;
    if (!name) {
      throw new Error(
        'node(): the wrapped function has no name; pass {name} explicitly.',
      );
    }
    return new FunctionNode(name, handler, options);
  },
};

/** Builds a {@link ToolNode} from a {@link BaseTool}. */
const TOOL_BUILDER: NodeBuilder = {
  match: (value) => isBaseTool(value),
  build: (value, options) => new ToolNode(value as BaseTool, options),
};

/**
 * The built-in node builders, consulted in order by `buildNode` / `isNodeLike`
 * to turn a bare function or tool into the right `BaseNode`.
 *
 * There is no agent builder: an agent is already a `BaseNode` and goes into a
 * graph as itself. What used to be built here — an `LLMAgentWrapper` around it
 * — now lives on the agent, as `LlmAgent.runImpl`.
 *
 * This is a single, explicit, statically-imported list — node-type modules are
 * wired in here rather than self-registering at import time, so there is no
 * global mutable registry and no import-order side effects. Order is the match
 * precedence (first match wins). Each node-type part adds its builder here.
 */
export const NODE_BUILDERS: readonly NodeBuilder[] = [
  FUNCTION_BUILDER,
  TOOL_BUILDER,
];

/**
 * Wraps an already-built node in a parallel worker, used by the engine for
 * `buildNode(..., {parallelWorker: true})`.
 */
export const PARALLEL_WORKER_FACTORY: ParallelWorkerFactory | undefined = (
  inner,
  options,
) => new ParallelWorker(inner, options);
