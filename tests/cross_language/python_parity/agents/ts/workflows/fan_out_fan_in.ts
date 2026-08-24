/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/fan_out_fan_in.
 *
 * The graph is identical: START fans out to three function nodes, a `JoinNode`
 * fans them back in, and `aggregate` formats the record the join produces.
 *
 * Two surface differences:
 *   - Python nests the parallel nodes in a *tuple* inside the edge chain; TS
 *     nests them in an array. Same `ChainElement` position, same meaning.
 *   - Python's `Event(message=...)` has no TS field; a message is
 *     `createEvent({content})` (content for the human, as opposed to `output`
 *     for the next node).
 */
import {
  createEvent,
  Event,
  JoinNode,
  node,
  NodeContext,
  Workflow,
} from '@google/adk';

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

const joinNode = new JoinNode({name: 'join_for_results'});

const aggregate = node(
  function* (_ctx: NodeContext, nodeInput: Record<string, unknown>) {
    yield message(
      `Uppercase: ${nodeInput['make_uppercase']}\n\n` +
        `Character Count: ${nodeInput['count_characters']}\n\n` +
        `Reversed: ${nodeInput['reverse_string']}\n\n`,
    );
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
