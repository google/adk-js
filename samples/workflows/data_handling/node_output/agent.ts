/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeScript port of the Python snippet in
 * https://adk.dev/graphs/data-handling/#node-output
 *
 *   def my_function_node(node_input: str):
 *       output_value = node_input.upper()
 *       return Event(output=output_value)   # "THE RESULT"
 *
 * A node hands data to its successor through the event's `output` field. Three
 * equivalent ways to produce it:
 *
 *   1. return a bare value            — boxed into `Event(output=value)` for you
 *   2. return `createEvent({output})` — the explicit form, when you also need
 *                                       `route`, `content`, or `actions`
 *   3. yield from a generator         — to stream progress alongside the result
 *
 * Caution: a node may emit only ONE event carrying `output` per execution. You
 * can yield as many events as you like, but only one of them may set `output` —
 * the rest should carry `content` (a display message) instead.
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

// 3. A generator: stream progress, then emit the single output event last.
const yieldProgressThenOutput = node(
  async function* (_ctx: NodeContext, nodeInput: string) {
    yield createEvent({
      content: {role: 'model', parts: [{text: 'Working on it...'}]},
    });
    // Only this event sets `output`, so the one-payload rule holds.
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
