/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Multi-triggers: a node with several predecessors runs once per incoming
 * trigger. One-to-one port of Python
 * `contributing/samples/workflows/multi_triggers/agent.py`.
 *
 * Run (offline):  npm run sample -- tests/integration/workflows/multi_triggers/agent.ts
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

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

const sendMessage = node(
  async function* (_c: NodeContext, nodeInput: unknown) {
    yield createEvent({
      content: {
        role: 'user',
        parts: [{text: `Triggered for input: ${nodeInput}`}],
      },
    });
  },
  {name: 'send_message'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  inputSchema: z.string(),
  edges: [
    ['START', [makeUppercase, countCharacters, reverseString], sendMessage],
  ],
});
