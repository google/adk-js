/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * User-facing messages
 * https://adk.dev/graphs/data-handling/#user-facing-messages
 *
 * A message for the human is the event's `content`: the runtime renders it, and
 * the graph does NOT forward it as node input. `content` is for the user,
 * `output` is for the next node.
 *
 * Because the first node below emits content only, the next node's input is
 * `undefined`.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/data_handling/user_message/agent.ts
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';

/** Emits a user-facing message: `content`, with no `output`. */
const message = (text: string) =>
  createEvent({content: {role: 'model', parts: [{text}]}});

// Tell the user the research process is starting. No `output`, so nothing is
// handed to the next node.
const userMessage = node(
  async function* (_ctx: NodeContext, nodeInput: string) {
    yield message(`Beginning research process for "${nodeInput}"...`);
  },
  {name: 'user_message'},
);

// A message AND an output in one node: two events, only one carrying `output`.
const research = node(
  async function* (_ctx: NodeContext) {
    yield message('Gathering sources...');
    yield createEvent({output: ['source-a', 'source-b', 'source-c']});
  },
  {name: 'research'},
);

const report = node(
  (_ctx: NodeContext, sources: string[]) =>
    `Research complete. ${sources.length} sources: ${sources.join(', ')}.`,
  {name: 'report'},
);

export const rootAgent = new Workflow({
  name: 'user_message_workflow',
  edges: [['START', userMessage, research, report]],
});
