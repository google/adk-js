/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The new ADK workflow module (parity port of `google/adk-python`
 * `google/adk/workflow`). Public surface mirrors Python's `__all__`, plus the
 * TypeScript-specific helpers and the types needed to use the
 * API from TypeScript.
 */

// --- Core graph / workflow ---
export {
  asRunnableRoot,
  isRunnableRoot,
  runNodeAsInvocation,
} from './run_node_as_invocation.js';
export type {
  RunNodeAsInvocationOptions,
  RunnableRoot,
} from './run_node_as_invocation.js';
export {Workflow, isWorkflow} from './workflow.js';
export type {DynamicEntry, WorkflowConfig} from './workflow.js';

// --- Nodes ---
export {BaseNode, START} from './base_node.js';
export type {BaseNodeConfig} from './base_node.js';
export {WorkflowNode, node} from './node.js';
export type {NodeOptions} from './node.js';
export {FunctionNode} from './nodes/function_node.js';
export type {
  FunctionNodeConfig,
  FunctionNodeHandler,
  FunctionNodeResult,
} from './nodes/function_node.js';
export {JoinNode} from './nodes/join_node.js';
export {NodeTool} from './nodes/node_tool.js';
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
  RunnableNode,
} from './graph.js';

// --- Execution context & state ---
export {BranchPath, commonPrefixOf, createSubBranch} from './branch_path.js';
export {NodeContext} from './node_context.js';
export type {NodeContextOptions, NodeResult} from './node_context.js';
export type {RunNodeOptions} from './node_runner.js';
export {createNodeState, isNodeState} from './node_state.js';
export type {NodeState} from './node_state.js';
export {NodeStatus} from './node_status.js';
export type {
  ScheduleDynamicNode,
  ScheduleDynamicNodeOptions,
} from './schedule_dynamic_node.js';

// --- HITL ---
export {RequestInput, isRequestInput} from './request_input.js';
export type {RequestInputParams} from './request_input.js';
export {
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from './utils/hitl_utils.js';

// --- Retry ---
export {normalizeRetryExceptions, prepareRetryConfig} from './retry_config.js';
export type {
  ErrorClass,
  PreparedRetryConfig,
  RetryConfig,
} from './retry_config.js';

// --- Errors ---
export {
  NodeSchemaValidationError,
  NodeTimeoutError,
  isNodeSchemaValidationError,
  isNodeTimeoutError,
} from './errors.js';
export {createNodeErrorEvent, isNodeErrorEvent} from './node_error_event.js';
export type {
  CreateNodeErrorEventParams,
  NodeErrorEvent,
} from './node_error_event.js';
