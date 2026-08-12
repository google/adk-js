/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeScript port of the Python snippet in
 * https://adk.dev/graphs/data-handling/#user-facing-messages
 *
 *   async def user_message(node_input: str):
 *     yield Event(message="Beginning research process...")
 *
 * `message` is for the human, `output` is for the next node. TypeScript events
 * have no `message` field: a user-facing message is the event's `content`, which
 * the runtime renders but the graph does NOT forward as node input.
 *
 * Because the first node below emits content only, the next node's input is
 * `undefined` — exactly the Python behaviour of a node that yields a message
 * and no output.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/data_handling/user_message/agent.ts
 */

import {createEvent, node, NodeContext, WorkflowAgent} from '@google/adk';

/** Emits a user-facing message (Python's `Event(message=...)`). */
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

export const rootAgent = new WorkflowAgent({
  name: 'user_message_workflow',
  edges: [['START', userMessage, research, report]],
});
