/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multi-triggers: a non-join node with several predecessors runs once per
 * incoming trigger. Mirrors Python `workflows/multi_triggers`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/multi_triggers/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

const producerA = node((_c: NodeContext, i: string) => `A(${i})`, {
  name: 'producer_a',
});
const producerB = node((_c: NodeContext, i: string) => `B(${i})`, {
  name: 'producer_b',
});

// `collector` is NOT a JoinNode, so it runs once for each predecessor trigger.
const collector = node(
  (_c: NodeContext, input: string) => `collected: ${input}`,
  {name: 'collector'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'multi_triggers',
    edges: [
      ['START', [producerA, producerB]],
      [producerA, collector],
      [producerB, collector],
    ],
  }),
);
