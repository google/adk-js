/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Request-input with rerun-on-resume: a single node both requests input and,
 * when resumed, re-runs to consume the reply and route. Mirrors Python
 * `workflows/request_input_rerun`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/request_input_rerun/agent.ts
 * Turn 1: describe a task. Turn 2: type "approve" or "reject".
 */

import {
  createEvent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const plan = node((_c: NodeContext, task: string) => `Plan for: ${task}`, {
  name: 'plan',
});

const humanReview = node(
  (ctx: NodeContext, planText: string) => {
    const reply = ctx.resumeInputs['human_review'];
    if (reply === undefined) {
      return new RequestInput({
        interruptId: 'human_review',
        message: `Approve this plan? Reply "approve" or "reject":\n\n${planText}`,
      });
    }
    return String(reply).toLowerCase().startsWith('a')
      ? createEvent({route: 'approved', output: planText})
      : createEvent({route: 'rejected'});
  },
  {name: 'human_review', rerunOnResume: true},
);

const execute = node(
  (_c: NodeContext, planText: string) => `Executed: ${planText}`,
  {
    name: 'execute',
  },
);
const cancel = node(() => 'Plan rejected; nothing executed.', {name: 'cancel'});

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'request_input_rerun',
    edges: [
      ['START', plan, humanReview],
      [humanReview, {approved: execute, rejected: cancel}],
    ],
  }),
);
