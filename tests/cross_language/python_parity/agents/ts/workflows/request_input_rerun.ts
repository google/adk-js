/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/workflows/request_input_rerun.
 *
 * The point of the sample is the other resume mode: `@node(rerun_on_resume=
 * True)` becomes `{rerunOnResume: true}`, so `human_review` runs its body again
 * when the answer arrives instead of completing with the reply as its output.
 * It then reads the reply out of `ctx.resumeInputs['human_review']` — keyed by
 * the fixed `interruptId` — and routes on it, all inside the one node. Compare
 * `request_input.ts`, where the same decision needs a second node.
 */
import {
  createEvent,
  LlmAgent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

/** Takes the initial customer complaint as input and sets it in the state. */
const processInput = node(
  function* (_ctx: NodeContext, nodeInput: string) {
    yield createEvent({
      actions: {stateDelta: {complaint: nodeInput, feedback: ''}},
    });
  },
  {name: 'process_input'},
);

const draftEmail = new LlmAgent({
  name: 'draft_email',
  model: PARITY_MODEL,
  instruction: `
    Please write a polite, helpful response email to the following customer complaint: "{complaint}"

    If there is any feedback from the manager to revise the draft, please incorporate it: "{feedback?}"
    `,
  outputKey: 'draft',
});

const humanReview = node(
  function* (ctx: NodeContext) {
    const resumeInput = ctx.resumeInputs['human_review'];
    if (!resumeInput) {
      const draft = ctx.state.get('draft');
      yield new RequestInput({
        interruptId: 'human_review',
        message:
          "Please review the following draft email and provide 'approve'," +
          ` 'reject', or feedback to revise.\n\n---\n${draft}\n---`,
      });
      return;
    }

    if (resumeInput === 'reject') {
      yield createEvent({route: 'rejected'});
    } else if (resumeInput === 'approve') {
      yield createEvent({route: 'approved'});
    } else {
      yield createEvent({
        actions: {stateDelta: {feedback: resumeInput}},
        route: 'revise',
      });
    }
  },
  {name: 'human_review', rerunOnResume: true},
);

const rejectEmail = node(
  function* () {
    yield createEvent({
      content: {role: 'model', parts: [{text: 'Draft rejected.'}]},
    });
  },
  {name: 'reject_email'},
);

const sendEmail = node(
  function* () {
    yield createEvent({
      content: {
        role: 'model',
        parts: [{text: 'Draft approved and sent successfully.'}],
      },
    });
  },
  {name: 'send_email'},
);

export const rootAgent = new Workflow({
  name: 'request_input_rerun',
  edges: [
    ['START', processInput, draftEmail, humanReview],
    [
      humanReview,
      {
        revise: draftEmail,
        approved: sendEmail,
        rejected: rejectEmail,
      },
    ],
  ],
});
