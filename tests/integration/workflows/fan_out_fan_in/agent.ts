/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Fan-out / fan-in: run three functions in parallel on the same input, join
 * their outputs, and aggregate. One-to-one port of Python
 * `contributing/samples/workflows/fan_out_fan_in/agent.py`.
 *
 * Run (offline):  npm run sample -- tests/integration/workflows/fan_out_fan_in/agent.ts
 */

import {createEvent, JoinNode, node, NodeContext, Workflow} from '@google/adk';

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

const joinNode = new JoinNode({name: 'join_for_results'});

const aggregate = node(
  async function* (_c: NodeContext, results: Record<string, unknown>) {
    yield createEvent({
      content: {
        role: 'user',
        parts: [
          {
            text:
              `Uppercase: ${results['make_uppercase']}\n\n` +
              `Character Count: ${results['count_characters']}\n\n` +
              `Reversed: ${results['reverse_string']}\n\n`,
          },
        ],
      },
    });
  },
  {name: 'aggregate'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    [
      'START',
      [makeUppercase, countCharacters, reverseString],
      joinNode,
      aggregate,
    ],
  ],
});
