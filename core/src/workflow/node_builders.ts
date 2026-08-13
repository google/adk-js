/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {BaseTool, isBaseTool} from '../tools/base_tool.js';
import {FunctionNode, FunctionNodeHandler} from './nodes/function_node.js';
import {isAgentLike, LLMAgentWrapper} from './nodes/llm_agent_wrapper.js';
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
 * Builds an {@link LLMAgentWrapper} from a {@link BaseAgent} (or agent-like
 * value). Tools are excluded explicitly (a `BaseTool` also exposes `runAsync`),
 * so the tool builder wins for those.
 */
const AGENT_BUILDER: NodeBuilder = {
  agentLike: true,
  match: (value) =>
    !isBaseTool(value) && (isBaseAgent(value) || isAgentLike(value)),
  build: (value, options) => new LLMAgentWrapper(value as BaseAgent, options),
};

/**
 * The built-in node builders, consulted in order by `buildNode` / `isNodeLike`
 * to turn a bare function / tool / agent into the right `BaseNode`.
 *
 * This is a single, explicit, statically-imported list — node-type modules are
 * wired in here rather than self-registering at import time, so there is no
 * global mutable registry and no import-order side effects. Order is the match
 * precedence (first match wins). Each node-type part adds its builder here.
 */
export const NODE_BUILDERS: readonly NodeBuilder[] = [
  FUNCTION_BUILDER,
  TOOL_BUILDER,
  AGENT_BUILDER,
];

/**
 * Wraps an already-built node in a parallel worker, used by the engine for
 * `buildNode(..., {parallelWorker: true})`.
 */
export const PARALLEL_WORKER_FACTORY: ParallelWorkerFactory | undefined = (
  inner,
  options,
) => new ParallelWorker(inner, options);
