/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration options: rerun on resume
 * https://adk.dev/graphs/human-input/#configuration-options
 *
 * `rerunOnResume` decides what happens to the node that paused:
 *   false (default)  the reply becomes that node's output and is handed to its
 *                    successor; the node body never runs again
 *   true             the node body re-runs from the top and reads the reply
 *                    from `ctx.resumeInputs[interruptId]` itself
 *
 * With `true`, asking and deciding collapse into one node: `human_review` below
 * raises the pause, then re-runs to approve, reject, or send feedback back for
 * a revision. The interrupt id is spelled out so the node can look its own
 * reply up.
 *
 * A node activated a second time within one run starts with an empty
 * `ctx.resumeInputs`, which is what ends the revise loop: the redraft pauses
 * for a fresh reply instead of reusing the last one.
 *
 * A resumed run replays the graph from START, and only a node that produced an
 * output is fast-forwarded to its cached result. `process_input` returns
 * nothing, so it runs again on every turn and has to guard its own write.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/human_input/rerun_on_resume/agent.ts
 * Turn 1: a complaint. Turn 2: "approve", "reject", or feedback to revise.
 */

import {
  createEvent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
} from '@google/adk';

// A plain-text reply is also a new user turn, so the entry node runs again on
// resume. Seed the complaint once, or the reviewer's answer overwrites it.
const processInput = node(
  (ctx: NodeContext, complaint: string) => {
    if (ctx.state.get('complaint') !== undefined) return;
    ctx.state.set('complaint', complaint.trim());
  },
  {name: 'process_input'},
);

// Stands in for the agent node that would write the reply; a live model adds
// nothing to the mechanic this sample is about, and keeps it offline.
const draftReply = node(
  (ctx: NodeContext) => {
    const complaint = ctx.state.get<string>('complaint') ?? '';
    const feedback = ctx.state.get<string>('feedback') ?? '';
    const revision = feedback ? ` (revised for: ${feedback})` : '';
    return `Dear customer, we are sorry about "${complaint}".${revision}`;
  },
  {name: 'draft_reply'},
);

const humanReview = node(
  (ctx: NodeContext, draft: string) => {
    const reply = ctx.resumeInputs['human_review'];
    if (reply === undefined) {
      return new RequestInput({
        interruptId: 'human_review',
        message:
          "Review the draft and reply 'approve', 'reject', or feedback to " +
          `revise.\n\n---\n${draft}\n---`,
      });
    }

    if (reply === 'approve') {
      return createEvent({route: 'approved'});
    }
    if (reply === 'reject') {
      return createEvent({route: 'rejected'});
    }
    ctx.state.set('feedback', String(reply));
    return createEvent({route: 'revise'});
  },
  {name: 'human_review', rerunOnResume: true},
);

const sendReply = node(() => 'Draft approved and sent successfully.', {
  name: 'send_reply',
});

const rejectReply = node(() => 'Draft rejected.', {name: 'reject_reply'});

export const rootAgent = new Workflow({
  name: 'review_workflow',
  edges: [
    ['START', processInput, draftReply, humanReview],
    [
      humanReview,
      {revise: draftReply, approved: sendReply, rejected: rejectReply},
    ],
  ],
});
