/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fan-out / fan-in: run three nodes in parallel on the same input, then join
 * their outputs and aggregate. Mirrors Python `workflows/fan_out_fan_in`.
 *
 * Run (offline, no API key):
 *   node dev/dist/esm/cli_entrypoint.js run samples/workflows/fan_out_fan_in/agent.ts
 */

import {
  JoinNode,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const makeUppercase = node((_c: NodeContext, s: string) => s.toUpperCase(), {
  name: 'make_uppercase',
});
const countCharacters = node((_c: NodeContext, s: string) => s.length, {
  name: 'count_characters',
});
const reverseString = node(
  (_c: NodeContext, s: string) => s.split('').reverse().join(''),
  {name: 'reverse_string'},
);

const aggregate = node(
  (_c: NodeContext, results: Record<string, unknown>) =>
    `Uppercase: ${results['make_uppercase']}\n` +
    `Character Count: ${results['count_characters']}\n` +
    `Reversed: ${results['reverse_string']}`,
  {name: 'aggregate'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'fan_out_fan_in',
    edges: [
      [
        'START',
        [makeUppercase, countCharacters, reverseString],
        new JoinNode({name: 'join_for_results'}),
        aggregate,
      ],
    ],
  }),
);
