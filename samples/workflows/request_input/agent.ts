/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Human-in-the-loop: draft an email, pause for human review, then route on the
 * reply (approve / reject / feedback-to-revise). Mirrors Python
 * `workflows/request_input`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/request_input/agent.ts
 * Turn 1: type a complaint. Turn 2: type "approve", "reject", or feedback text.
 */

import {
  createEvent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const processInput = node(
  (ctx: NodeContext, complaint: string) => {
    ctx.state.set('complaint', complaint);
    ctx.state.set('feedback', '');
    return complaint;
  },
  {name: 'process_input'},
);

const draftEmail = node(
  (ctx: NodeContext) => {
    const complaint = ctx.state.get('complaint');
    const feedback = ctx.state.get('feedback');
    const base = `Dear Customer,\n\nRegarding your complaint ("${complaint}"), we sincerely apologize and will make it right.`;
    return feedback ? `${base}\n\n[Revised per feedback: ${feedback}]` : base;
  },
  {name: 'draft_email'},
);

const humanReview = node(
  (ctx: NodeContext, draft: string) => {
    const decision = ctx.resumeInputs['review'];
    if (decision === undefined) {
      return new RequestInput({
        interruptId: 'review',
        message: `Please review this draft. Reply "approve", "reject", or give feedback:\n\n---\n${draft}\n---`,
      });
    }
    const d = String(decision).trim().toLowerCase();
    if (d === 'approve') {
      return createEvent({route: 'approved', output: draft});
    }
    if (d === 'reject') {
      return createEvent({route: 'rejected'});
    }
    ctx.state.set('feedback', decision);
    return createEvent({route: 'revise'});
  },
  {name: 'human_review'},
);

const sendEmail = node(
  (_c: NodeContext, draft: string) => `Approved and sent:\n\n${draft}`,
  {name: 'send_email'},
);
const rejectEmail = node(() => 'Draft rejected. No email sent.', {
  name: 'reject_email',
});

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'request_input',
    edges: [
      ['START', processInput, draftEmail, humanReview],
      [
        humanReview,
        {approved: sendEmail, rejected: rejectEmail, revise: draftEmail},
      ],
    ],
  }),
);
