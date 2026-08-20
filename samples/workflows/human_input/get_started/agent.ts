/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Human input: get started
 * https://adk.dev/graphs/human-input/#get-started
 *
 * `step1` pauses the workflow until the user replies; the reply is then handed
 * to the next node as its input. This is the default `rerunOnResume: false`
 * handoff: the interrupted node does NOT re-run — it completes with the user's
 * reply as its output.
 *
 * A HITL node needs no model, which makes the pause fully deterministic.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/human_input/get_started/agent.ts
 * Turn 1: anything. Turn 2: type a number, e.g. "21".
 */

import {node, NodeContext, RequestInput, Workflow} from '@google/adk';

const step1 = node(
  async function* () {
    yield new RequestInput({message: 'Enter a number:'});
  },
  {name: 'step1'},
);

const step2 = node(
  (_ctx: NodeContext, nodeInput: string | number) => {
    // An interactive reply arrives as text, so coerce before doing maths.
    const value = Number(nodeInput);
    return Number.isFinite(value)
      ? value * 2
      : `"${nodeInput}" is not a number.`;
  },
  {name: 'step2'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', step1, step2]],
});
