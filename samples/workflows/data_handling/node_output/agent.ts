/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node output
 * https://adk.dev/graphs/data-handling/#node-output
 *
 * A node hands data to its successor through the event's `output` field. Three
 * equivalent ways to produce it:
 *
 *   1. return a bare value            — boxed into an event's `output` for you
 *   2. return `createEvent({output})` — the explicit form, when you also need
 *                                       `route`, `content`, or `actions`
 *   3. yield from a generator         — to stream progress alongside the result
 *
 * Caution: emit `output` from ONE event per execution. Nothing enforces that,
 * so getting it wrong is silent — a node may yield any number of events
 * carrying `output`, each overwrites the last, and the successor receives only
 * the final value. Carry progress on `content` instead.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/data_handling/node_output/agent.ts
 */

import {createEvent, node, NodeContext, WorkflowAgent} from '@google/adk';

// 1. A bare return value.
const returnRawValue = node(
  (_ctx: NodeContext, nodeInput: string) => nodeInput.toUpperCase(),
  {name: 'return_raw_value'},
);

// 2. An explicit Event.
const returnEventOutput = node(
  (_ctx: NodeContext, nodeInput: string) =>
    createEvent({output: `${nodeInput}!`}),
  {name: 'return_event_output'},
);

// 3. A generator: stream progress, then emit the output event last.
const yieldProgressThenOutput = node(
  async function* (_ctx: NodeContext, nodeInput: string) {
    // Progress goes on `content`: displayed, and not passed to the successor.
    yield createEvent({
      content: {role: 'model', parts: [{text: 'Working on it...'}]},
    });
    // Exactly one event sets `output`, so there is nothing to overwrite it.
    yield createEvent({output: `<<${nodeInput}>>`});
  },
  {name: 'yield_progress_then_output'},
);

export const rootAgent = new WorkflowAgent({
  name: 'node_output_workflow',
  edges: [
    ['START', returnRawValue, returnEventOutput, yieldProgressThenOutput],
  ],
});
