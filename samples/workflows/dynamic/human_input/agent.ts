/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Human input in a dynamic workflow
 * https://adk.dev/graphs/dynamic/#human-input
 *
 * Important: a parent node that calls `ctx.runNode` must set
 * `rerunOnResume: true`, or it cannot handle an interrupt raised by a child.
 * The leaf keeps `rerunOnResume: false`: on resume it does not re-run its body,
 * it completes with the human's reply as its output, and `ctx.runNode()` hands
 * that back to the caller.
 *
 * `ctx.runNode()` does NOT throw when a child interrupts. It resolves with a
 * result whose `interruptIds` are populated and whose `output` is still
 * undefined, so the orchestrator has to check and bail out — otherwise it
 * decides on an answer the human never gave.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/dynamic/human_input/agent.ts
 * Turn 1: describe a request. Turn 2: type "yes" or "no".
 */

import {node, NodeContext, RequestInput, WorkflowAgent} from '@google/adk';

/**
 * Pauses the workflow and waits for user input.
 *
 * `rerunOnResume: false` (the default, spelled out here because it is the
 * point) is what makes this a one-liner: the reply is handed to the node as
 * its output instead of the body running a second time to collect it.
 */
const getUserApproval = node(
  () => new RequestInput({message: 'Please approve this request (Yes/No)'}),
  {name: 'get_user_approval', rerunOnResume: false},
);

/** The orchestrator calling the interactive step. */
const handleProcess = node(
  async (ctx: NodeContext, nodeInput: unknown) => {
    const approval = await ctx.runNode(getUserApproval, nodeInput);

    // Still waiting on the human: return without deciding. The workflow pauses
    // and this body re-runs once the reply arrives.
    if (approval.interruptIds.length > 0) {
      return undefined;
    }

    const userResponse = String(approval.output ?? '')
      .trim()
      .toLowerCase();

    if (userResponse === 'yes') {
      return 'Approved';
    }
    return 'Denied';
  },
  {name: 'handle_process', rerunOnResume: true},
);

export const rootAgent = new WorkflowAgent({
  name: 'root_agent',
  edges: [['START', handleProcess]],
});
