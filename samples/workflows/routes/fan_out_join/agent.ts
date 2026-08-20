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
 * Caution: the barrier waits for every predecessor to COMPLETE, not to produce
 * an output. A predecessor that finishes without one still releases the join,
 * and arrives in the record as its name mapped to `undefined` — so reading a
 * field off it throws somewhere downstream, far from the node that skipped it.
 * Give anything feeding a join an output of its own, and a `retryConfig` if it
 * can fail; treat a missing one as a bug rather than as a pause.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/routes/fan_out_join/agent.ts
 */

import {JoinNode, node, NodeContext, Workflow} from '@google/adk';

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

export const rootAgent = new Workflow({
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
