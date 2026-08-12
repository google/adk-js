/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/request_input/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Human-in-the-loop (two-node pattern). An LlmAgent drafts a reply to a customer
 * complaint; `request_human_review` pauses the workflow (RequestInput) and, on
 * resume, its successor `handle_human_review` receives the human's reply as its
 * input and routes on it (approve / reject / feedback-to-revise). Faithful port
 * of Python `contributing/samples/workflows/request_input`.
 *
 * The two-node split relies on `rerun_on_resume=false` semantics: the node that
 * raised the interrupt does NOT re-run on resume; instead it completes with the
 * resume value as its output, which feeds the next node.
 *
 * REQUIRES an API key (draft_email calls a live model). Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/request_input/agent.ts
 * Turn 1: type a complaint. Turn 2: type "approve", "reject", or feedback text.
 */

import {
  createEvent,
  LlmAgent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
} from '@google/adk';

/** Emits a plain display message (Python `Event(message=...)`). */
const message = (text: string) =>
  createEvent({content: {role: 'model', parts: [{text}]}});

// Takes the initial customer complaint and seeds it into workflow state.
const processInput = node(
  (ctx: NodeContext, complaint: string) => {
    ctx.state.set('complaint', complaint);
    ctx.state.set('feedback', '');
  },
  {name: 'process_input'},
);

const draftEmail = new LlmAgent({
  name: 'draft_email',
  model: 'gemini-2.5-flash',
  instruction: `
    Please write a polite, helpful response email to the following customer complaint: "{complaint}"

    If there is any feedback from the manager to revise the draft, please incorporate it: "{feedback?}"
    `,
  outputKey: 'draft',
});

// Pauses the workflow to request human review of the draft. With the default
// rerun_on_resume=false, on resume this node does NOT re-run — it completes with
// the reviewer's reply as its output, which becomes handle_human_review's input.
const requestHumanReview = node(
  (_ctx: NodeContext, draft: string) =>
    new RequestInput({
      message:
        "Please review the following draft email and provide 'approve', " +
        `'reject', or feedback to revise.\n\n---\n${draft}\n---`,
    }),
  {name: 'request_human_review'},
);

// Receives the human's reply (the resume value) as its input and routes on it.
const handleHumanReview = node(
  (ctx: NodeContext, nodeInput: string) => {
    // Normalize the reply (case/whitespace) before matching, so "Approve" or
    // "approve " don't fall through to the revise branch.
    const reply = String(nodeInput).trim().toLowerCase();
    if (reply === 'reject') {
      return createEvent({route: 'rejected'});
    }
    if (reply === 'approve') {
      return createEvent({route: 'approved'});
    }
    ctx.state.set('feedback', nodeInput);
    return createEvent({route: 'revise'});
  },
  {name: 'handle_human_review'},
);

const rejectEmail = node(() => message('Draft rejected.'), {
  name: 'reject_email',
});

const sendEmail = node(() => message('Draft approved and sent successfully.'), {
  name: 'send_email',
});

export const rootAgent = new Workflow({
  name: 'request_input',
  edges: [
    ['START', processInput, draftEmail, requestHumanReview, handleHumanReview],
    [
      handleHumanReview,
      {revise: draftEmail, approved: sendEmail, rejected: rejectEmail},
    ],
  ],
});
