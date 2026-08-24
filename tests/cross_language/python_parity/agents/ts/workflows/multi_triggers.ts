/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/multi_triggers.
 *
 * Same graph as `fan_out_fan_in` minus the `JoinNode`: without a fan-in
 * barrier, each of the three upstream outputs triggers `send_message`
 * independently, so it runs three times.
 *
 * `input_schema=str` becomes `inputSchema: z.string()` — `SchemaLike` accepts
 * any Zod type, not just an object, so a scalar workflow input translates
 * directly.
 */
import {createEvent, Event, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

/** Python's `Event(message=...)`. */
function message(text: string): Event {
  return createEvent({content: {role: 'model', parts: [{text}]}});
}

const makeUppercase = node(
  (_ctx: NodeContext, nodeInput: string) => nodeInput.toUpperCase(),
  {name: 'make_uppercase'},
);

const countCharacters = node(
  (_ctx: NodeContext, nodeInput: string) => nodeInput.length,
  {name: 'count_characters'},
);

const reverseString = node(
  (_ctx: NodeContext, nodeInput: string) => [...nodeInput].reverse().join(''),
  {name: 'reverse_string'},
);

const sendMessage = node(
  function* (_ctx: NodeContext, nodeInput: unknown) {
    yield message(`Triggered for input: ${String(nodeInput)}`);
  },
  {name: 'send_message'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    ['START', [makeUppercase, countCharacters, reverseString], sendMessage],
  ],
  inputSchema: z.string(),
});
