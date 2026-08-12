/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parallel tasks: fan out and join paths
 * https://adk.dev/graphs/routes/#parallel-tasks-fan-out-and-join-paths
 *
 * A `JoinNode` is a fan-in barrier: it waits for EVERY predecessor to finish and
 * then hands the next node an object keyed by predecessor node name.
 *
 * Caution: a JoinNode proceeds only once all upstream nodes have produced an
 * output. If one fails to produce output the join is stuck and the workflow
 * stops — give any node feeding a join a failsafe output (or a `retryConfig`).
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/routes/fan_out_join/agent.ts
 */

import {JoinNode, node, NodeContext, WorkflowAgent} from '@google/adk';

const parallelTaskA = node(
  (_ctx: NodeContext, text: string) => text.toUpperCase(),
  {name: 'parallel_task_A'},
);

const parallelTaskB = node((_ctx: NodeContext, text: string) => text.length, {
  name: 'parallel_task_B',
});

const parallelTaskC = node(
  (_ctx: NodeContext, text: string) => text.split('').reverse().join(''),
  {name: 'parallel_task_C'},
);

const myJoinNode = new JoinNode({name: 'my_join_node'});

// The join hands its successor a record keyed by predecessor node name.
const finalTaskD = node(
  (_ctx: NodeContext, results: Record<string, unknown>) =>
    [
      `Uppercase: ${results['parallel_task_A']}`,
      `Length:    ${results['parallel_task_B']}`,
      `Reversed:  ${results['parallel_task_C']}`,
    ].join('\n'),
  {name: 'final_task_D'},
);

export const rootAgent = new WorkflowAgent({
  name: 'fan_out_workflow',
  // One edge row per parallel path. The equivalent shorthand nests the
  // parallel nodes in an array:
  //   [['START', [parallelTaskA, parallelTaskB, parallelTaskC], myJoinNode,
  //     finalTaskD]]
  edges: [
    ['START', parallelTaskA, myJoinNode],
    ['START', parallelTaskB, myJoinNode],
    ['START', parallelTaskC, myJoinNode],
    [myJoinNode, finalTaskD],
  ],
});
