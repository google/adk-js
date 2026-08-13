/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nodes
 * https://adk.dev/graphs/routes/#nodes
 *
 * The simplest node type: a plain function wrapped as a FunctionNode. It takes
 * text in, returns text out, and the framework hands that value to the next
 * node as its input — no session-state writes needed.
 *
 * A bare return value is boxed into an `Event` carrying that `output` for you,
 * so both forms below hand the next node the same thing.
 *
 * They do NOT render the same, though: boxing a bare return also gives the
 * event display `content`, so `my_function_node` prints a `[my_function_node]:`
 * line, while `add_suffix` sets `output` only and prints nothing. A node that
 * emits no display content is invisible in the CLI — expected, and worth
 * recognising now, because most routers later on look "skipped" for the same
 * reason.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/routes/function_node/agent.ts
 */

import {
  createEvent,
  node,
  NodeContext,
  WorkflowAgent,
  type FunctionNodeHandler,
} from '@google/adk';

/** A bare return value: boxed into an event's `output` for you. */
const myFunctionNode: FunctionNodeHandler<string, string> = (
  _ctx: NodeContext,
  nodeInput: string,
) => {
  const inputTextModified = nodeInput.toUpperCase();
  return inputTextModified;
};

/** The explicit form — identical behaviour, useful when you also set `route`. */
const myExplicitEventNode = (_ctx: NodeContext, nodeInput: string) =>
  createEvent({output: `${nodeInput} IS AWESOME!`});

export const rootAgent = new WorkflowAgent({
  name: 'function_node_pipeline',
  edges: [
    [
      'START',
      node(myFunctionNode, {name: 'my_function_node'}),
      node(myExplicitEventNode, {name: 'add_suffix'}),
    ],
  ],
});
