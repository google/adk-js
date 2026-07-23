/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The new ADK workflow module (parity port of `google/adk-python`
 * `google/adk/workflow`). Public surface mirrors Python's `__all__`, plus the
 * TypeScript-specific `WorkflowAgent` adapter and the types needed to use the
 * API from TypeScript.
 */

// --- Core graph / workflow ---
export {Workflow} from './workflow.js';
export type {DynamicEntry, WorkflowConfig} from './workflow.js';
export {WorkflowAgent} from './workflow_agent.js';
export type {WorkflowAgentConfig} from './workflow_agent.js';

// --- Nodes ---
export {BaseNode, START} from './base_node.js';
export type {BaseNodeConfig} from './base_node.js';
export {Node, node} from './node.js';
export type {NodeOptions} from './node.js';
export {FunctionNode} from './nodes/function_node.js';
export type {
  FunctionNodeConfig,
  FunctionNodeHandler,
  FunctionNodeResult,
} from './nodes/function_node.js';
export {JoinNode} from './nodes/join_node.js';
export {LLMAgentWrapper} from './nodes/llm_agent_wrapper.js';
export type {LLMAgentWrapperConfig} from './nodes/llm_agent_wrapper.js';
export {ParallelWorker} from './nodes/parallel_worker.js';
export type {ParallelWorkerConfig} from './nodes/parallel_worker.js';
export {ToolNode} from './nodes/tool_node.js';
export type {ToolNodeConfig} from './nodes/tool_node.js';
export type {BuildNodeOptions} from './utils/workflow_graph_utils.js';

// --- Graph model ---
export {DEFAULT_ROUTE, Edge, Graph} from './graph.js';
export type {
  ChainElement,
  EdgeItem,
  NodeLike,
  RouteValue,
  RoutingMap,
} from './graph.js';

// --- Execution context & state ---
export {BranchPath} from './branch_path.js';
export {NodeContext} from './node_context.js';
export type {RunNodeOptions} from './node_runner.js';
export {createNodeState, isNodeState} from './node_state.js';
export type {NodeState} from './node_state.js';
export {NodeStatus} from './node_status.js';

// --- HITL ---
export {RequestInput, isRequestInput} from './request_input.js';
export type {RequestInputParams} from './request_input.js';

// --- Retry ---
export {normalizeRetryExceptions} from './retry_config.js';
export type {ErrorClass, RetryConfig} from './retry_config.js';

// --- Errors ---
export {NodeTimeoutError} from './errors.js';
