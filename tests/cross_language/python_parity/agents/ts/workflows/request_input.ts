/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/request_input.
 *
 * The graph is identical: draft, pause for a human, then route on the reply
 * back to the drafter (revise), to `send_email`, or to `reject_email`.
 *
 * Two translations, both of which the sibling ports already make:
 *   - Python binds a state key to a node parameter by name
 *     (`request_human_review(draft: str)`); TS has no parameter injection, so
 *     the same key is read through `ctx.state`.
 *   - `Event(state=...)` / `Event(message=...)` become
 *     `createEvent({actions: {stateDelta}})` / `createEvent({content})`.
 *
 * `request_human_review` keeps the default `rerunOnResume: false`, so the
 * node does not run again on resume — it completes with the human's reply as
 * its output, which is exactly what `handle_human_review` receives as input.
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

const requestHumanReview = node(
  function* (ctx: NodeContext) {
    const draft = ctx.state.get('draft');
    yield new RequestInput({
      message:
        "Please review the following draft email and provide 'approve'," +
        ` 'reject', or feedback to revise.\n\n---\n${draft}\n---`,
    });
  },
  {name: 'request_human_review'},
);

const handleHumanReview = node(
  function* (_ctx: NodeContext, nodeInput: string) {
    if (nodeInput === 'reject') {
      yield createEvent({route: 'rejected'});
    } else if (nodeInput === 'approve') {
      yield createEvent({route: 'approved'});
    } else {
      yield createEvent({
        actions: {stateDelta: {feedback: nodeInput}},
        route: 'revise',
      });
    }
  },
  {name: 'handle_human_review'},
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
  name: 'request_input',
  edges: [
    ['START', processInput, draftEmail, requestHumanReview, handleHumanReview],
    [
      handleHumanReview,
      {
        revise: draftEmail,
        approved: sendEmail,
        rejected: rejectEmail,
      },
    ],
  ],
});
