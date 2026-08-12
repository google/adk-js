/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/request_input_advanced/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Advanced human-in-the-loop with structured schemas. An LlmAgent extracts a
 * structured time-off request; `evaluate_request` auto-approves short requests
 * (<= 1 day) and otherwise pauses for manager approval (RequestInput carrying a
 * response schema). `process_decision` renders the outcome. Faithful port of
 * Python `contributing/samples/workflows/request_input_advanced`.
 *
 * The manager-approval branch uses `rerun_on_resume=false`: evaluate_request
 * does not re-run on resume; its output becomes the manager's decision, which
 * feeds process_decision.
 *
 * REQUIRES an API key (process_request calls a live model). Set GEMINI_API_KEY:
 *   npm run sample -- samples/workflows/request_input_advanced/agent.ts
 * Turn 1: e.g. "I need 3 days off next week for a family trip".
 * Turn 2 (only if > 1 day): type "yes" or "no" to approve/deny.
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
  days: z.number().describe('Number of days requested.'),
  reason: z.string().describe('Reason for the time off.'),
});
type TimeOffRequest = z.infer<typeof timeOffRequestSchema>;

const timeOffDecisionSchema = z.object({
  approved: z.boolean().describe('Whether the time off is approved.'),
  approvedDays: z.number().nullish().describe('Number of days approved.'),
});
type TimeOffDecision = z.infer<typeof timeOffDecisionSchema>;

/** Emits a plain display message (Python `Event(message=...)`). */
const message = (text: string) =>
  createEvent({content: {role: 'model', parts: [{text}]}});

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
    ctx: NodeContext,
    request: TimeOffRequest,
  ): TimeOffDecision | RequestInput => {
    // Persist the request so process_decision can read it back (TypeScript has
    // no signature-based state injection like Python's `request` parameter).
    ctx.state.set('request', request);

    if (request.days <= 1) {
      return {approved: true, approvedDays: request.days};
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
  (ctx: NodeContext, nodeInput: TimeOffDecision | string) => {
    const request = ctx.state.get<TimeOffRequest>('request');
    const decision = normalizeDecision(nodeInput);

    if (decision.approved) {
      const approvedDays = decision.approvedDays ?? request?.days ?? 0;
      return message(
        `Time Off Approved! ${approvedDays} out of ${request?.days ?? approvedDays} days granted.`,
      );
    }
    return message('Time Off Denied.');
  },
  {name: 'process_decision'},
);

/**
 * Accepts either a structured {@link TimeOffDecision} (auto-approve path or a
 * structured resume) or a plain-string reply typed by an interactive user
 * (e.g. "yes"/"no"), and normalizes it to a decision.
 */
function normalizeDecision(input: TimeOffDecision | string): TimeOffDecision {
  if (typeof input === 'string') {
    const yes = ['yes', 'y', 'true', 'approve', 'approved'].includes(
      input.trim().toLowerCase(),
    );
    return {approved: yes};
  }
  return input;
}

export const rootAgent = new Workflow({
  name: 'request_input_advanced',
  edges: [['START', processRequest, evaluateRequest, processDecision]],
});
