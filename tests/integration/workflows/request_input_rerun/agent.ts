/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Human-in-the-loop (single-node, rerun-on-resume). An LlmAgent drafts a reply;
 * one `human_review` node both raises the RequestInput and, because it is marked
 * `rerunOnResume: true`, RE-RUNS on resume to consume the reply (via
 * `ctx.resumeInputs`) and route. One-to-one port of Python
 * `contributing/samples/workflows/request_input_rerun/agent.py`.
 *
 * REQUIRES an API key (draft_email calls a live model). Set GEMINI_API_KEY, then:
 *   npm run sample -- tests/integration/workflows/request_input_rerun/agent.ts
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

/** Python's `Event(message=...)` content shape (role `user`). */
const message = (text: string) =>
  createEvent({content: {role: 'user', parts: [{text}]}});

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

// A single node that both requests input and, on resume (it re-runs because
// rerunOnResume is true), consumes the reply from ctx.resumeInputs and routes.
const humanReview = node(
  (ctx: NodeContext, draft: string) => {
    const resumeInput = ctx.resumeInputs['human_review'];
    if (!resumeInput) {
      return new RequestInput({
        interruptId: 'human_review',
        message:
          "Please review the following draft email and provide 'approve', " +
          `'reject', or feedback to revise.\n\n---\n${draft}\n---`,
      });
    }

    if (resumeInput === 'reject') {
      return createEvent({route: 'rejected'});
    }
    if (resumeInput === 'approve') {
      return createEvent({route: 'approved'});
    }
    ctx.state.set('feedback', resumeInput);
    return createEvent({route: 'revise'});
  },
  {name: 'human_review', rerunOnResume: true},
);

const rejectEmail = node(() => message('Draft rejected.'), {
  name: 'reject_email',
});

const sendEmail = node(() => message('Draft approved and sent successfully.'), {
  name: 'send_email',
});

export const rootAgent = new Workflow({
  name: 'request_input_rerun',
  edges: [
    ['START', processInput, draftEmail, humanReview],
    [
      humanReview,
      {revise: draftEmail, approved: sendEmail, rejected: rejectEmail},
    ],
  ],
});
