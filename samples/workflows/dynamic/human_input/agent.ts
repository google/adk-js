/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeScript port of the Python snippet in
 * https://adk.dev/graphs/dynamic/#human-input
 *
 *   @node(rerun_on_resume=False)
 *   async def get_user_approval(ctx: Context, node_input: Any):
 *       yield RequestInput(message="Please approve this request (Yes/No)")
 *
 *   @node(rerun_on_resume=True)
 *   async def handle_process(ctx: Context, node_input: Any):
 *       user_response = await ctx.run_node(get_user_approval)
 *       if user_response.lower() == "yes":
 *           return "Approved"
 *       return "Denied"
 *
 * Important: a parent node that calls `ctx.runNode` must set
 * `rerunOnResume: true`, or it cannot handle an interrupt raised by a child.
 *
 * !! Two TypeScript differences from the Python snippet. !!
 *
 * 1. `ctx.runNode()` does NOT throw when a child interrupts. It resolves with a
 *    result whose `interruptIds` are populated and whose `output` is still
 *    undefined, so the orchestrator has to check and bail out — otherwise it
 *    decides on an answer the human never gave.
 *
 * 2. The `rerun_on_resume=False` leaf ("complete with the human's reply as my
 *    output") is implemented for STATIC GRAPH nodes only — see
 *    samples/workflows/human_input/get_started, where that handoff is exactly
 *    what makes the two-node pattern work. A dynamic `ctx.runNode` child is
 *    always re-run instead, so the leaf here uses the re-entry form: a stable
 *    `interruptId`, and a `ctx.resumeInputs[id]` lookup that returns the reply
 *    on the second pass.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/dynamic/human_input/agent.ts
 * Turn 1: describe a request. Turn 2: type "yes" or "no".
 */

import {node, NodeContext, RequestInput, WorkflowAgent} from '@google/adk';

/** Stable id so the reply can be matched back to this pause on resume. */
const APPROVAL_INTERRUPT_ID = 'user_approval';

/** Pauses the workflow and waits for user input. */
const getUserApproval = node(
  (ctx: NodeContext) => {
    const reply = ctx.resumeInputs[APPROVAL_INTERRUPT_ID];
    if (reply === undefined) {
      // First pass: raise the interrupt and pause.
      return new RequestInput({
        interruptId: APPROVAL_INTERRUPT_ID,
        message: 'Please approve this request (Yes/No)',
      });
    }
    // Second pass: the human's reply becomes this node's output.
    return reply;
  },
  {name: 'get_user_approval', rerunOnResume: true},
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
