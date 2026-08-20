/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Advanced human-in-the-loop with structured schemas. An LlmAgent extracts a
 * structured time-off request; `evaluate_request` auto-approves short requests
 * (<= 1 day) and otherwise pauses for manager approval (RequestInput carrying a
 * response schema). `process_decision` renders the outcome. One-to-one port of
 * Python `contributing/samples/workflows/request_input_advanced/agent.py`.
 *
 * The manager-approval branch uses `rerunOnResume: false` (the default):
 * evaluate_request does not re-run on resume; its output becomes the manager's
 * decision, which feeds process_decision.
 *
 * REQUIRES an API key (process_request calls a live model). Set GEMINI_API_KEY:
 *   npm run sample -- tests/integration/workflows/request_input_advanced/agent.ts
 * Turn 1: e.g. "2 sick days".
 * Turn 2 (only if > 1 day): reply with the structured decision, e.g.
 * `{"approved": true}`.
 */

import {
  createEvent,
  LlmAgent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
} from '@google/adk';
import {z} from 'zod';

const timeOffRequestSchema = z.object({
  days: z.number().int().describe('Number of days requested.'),
  reason: z.string().describe('Reason for the time off.'),
});
type TimeOffRequest = z.infer<typeof timeOffRequestSchema>;

const timeOffDecisionSchema = z
  .object({
    approved: z.boolean().describe('Whether the time off is approved.'),
    approved_days: z
      .number()
      .int()
      .nullish()
      .describe('Number of days approved.'),
  })
  .describe('The structured response we expect back from the human manager.');
type TimeOffDecision = z.infer<typeof timeOffDecisionSchema>;

/** Python's `Event(message=...)` content shape (role `user`). */
const message = (text: string) =>
  createEvent({content: {role: 'user', parts: [{text}]}});

const processRequest = new LlmAgent({
  name: 'process_request',
  model: 'gemini-2.5-flash',
  instruction:
    "Extract the number of days and the reason from the user's natural " +
    'language time off request.',
  outputSchema: timeOffRequestSchema,
  outputKey: 'request',
});

// If days <= 1, it's auto-approved. Otherwise, route to manager review by
// raising a RequestInput that carries the request as payload and declares the
// expected response schema.
const evaluateRequest = node(
  (
    _ctx: NodeContext,
    request: TimeOffRequest,
  ): TimeOffDecision | RequestInput => {
    if (request.days <= 1) {
      return {approved: true};
    }
    return new RequestInput({
      interruptId: 'manager_approval',
      message: 'Please review this time off request.',
      payload: request,
      responseSchema: timeOffDecisionSchema,
    });
  },
  {name: 'evaluate_request'},
);

const processDecision = node(
  (ctx: NodeContext, nodeInput: TimeOffDecision) => {
    const request = ctx.state.get<TimeOffRequest>('request')!;

    if (nodeInput.approved) {
      const approvedDays = nodeInput.approved_days ?? request.days;
      return message(
        `Time Off Approved! ${approvedDays} out of ${request.days} days granted.`,
      );
    }
    return message('Time Off Denied.');
  },
  {name: 'process_decision', inputSchema: timeOffDecisionSchema},
);

export const rootAgent = new Workflow({
  name: 'request_input_advanced',
  edges: [['START', processRequest, evaluateRequest, processDecision]],
});
