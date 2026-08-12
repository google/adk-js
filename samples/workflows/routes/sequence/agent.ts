/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeScript port of the Python snippet in
 * https://adk.dev/graphs/routes/#route-sequences
 *
 *   edges=[("START", task_A_node)]                              # single node
 *   edges=[("START", task_A_node, task_B_node, task_C_node)]    # 3 in order
 *
 * A sequential route runs each node once, in the listed order. Each node's
 * return value is delivered to the next node as its input.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/routes/sequence/agent.ts
 */

import {node, NodeContext, WorkflowAgent} from '@google/adk';

const taskANode = node(
  (_ctx: NodeContext, nodeInput: string) => `Summary: ${nodeInput.trim()}`,
  {name: 'task_A_node'},
);

const taskBNode = node(
  (_ctx: NodeContext, summary: string) => summary.toUpperCase(),
  {name: 'task_B_node'},
);

const taskCNode = node(
  (_ctx: NodeContext, shouted: string) => `${shouted} (done)`,
  {name: 'task_C_node'},
);

// A single-node graph would simply be:
//   edges: [['START', taskANode]]
export const rootAgent = new WorkflowAgent({
  name: 'sequential_workflow',
  edges: [['START', taskANode, taskBNode, taskCNode]],
});
