/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/workflows/request_input_advanced.
 *
 * The advanced bits of `RequestInput` all exist in adk-js under the same
 * names: a fixed `interruptId`, a structured `payload` sent alongside the
 * prompt, and a `responseSchema` describing the reply. `evaluate_request`
 * returns either a decision or a `RequestInput`, and a returned `RequestInput`
 * pauses the workflow exactly as a yielded one does.
 *
 * `process_decision(request, node_input)` binds a state key by parameter name
 * in Python; TS reads `request` through `ctx.state`.
 *
 * The reply itself is where the two runtimes can part company. A structured
 * `adk_request_input` response is unwrapped and JSON-parsed into a
 * `TimeOffDecision`; a plain-text reply (all a scripted `--replay` turn can
 * be) is routed to the interrupt verbatim, as a string. `responseSchema` never
 * coerces a human's answer into shape — it only tells a client what to collect
 * — so this node accepts both, the way `samples/workflows/human_input`
 * documents.
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

import {PARITY_MODEL} from '../model.ts';

const TimeOffRequestSchema = z.object({
  days: z.number().int().describe('Number of days requested.'),
  reason: z.string().describe('Reason for the time off.'),
});
type TimeOffRequest = z.infer<typeof TimeOffRequestSchema>;

/** The structured response we expect back from the human manager. */
const TimeOffDecisionSchema = z.object({
  approved: z.boolean().describe('Whether the time off is approved.'),
  approved_days: z
    .number()
    .int()
    .nullish()
    .default(null)
    .describe('Number of days approved.'),
});
type TimeOffDecision = z.infer<typeof TimeOffDecisionSchema>;

const processRequest = new LlmAgent({
  name: 'process_request',
  model: PARITY_MODEL,
  instruction:
    "Extract the number of days and the reason from the user's natural" +
    ' language time off request.',
  outputSchema: TimeOffRequestSchema,
  outputKey: 'request',
});

/**
 * If days <= 1, it's auto-approved. Otherwise, routes to manager review.
 */
const evaluateRequest = node(
  (ctx: NodeContext) => {
    const request = ctx.state.get('request') as TimeOffRequest;
    if (request.days <= 1) {
      return {approved: true, approved_days: null} satisfies TimeOffDecision;
    } else {
      return new RequestInput({
        interruptId: 'manager_approval',
        message: 'Please review this time off request.',
        payload: request,
        responseSchema: TimeOffDecisionSchema,
      });
    }
  },
  {name: 'evaluate_request'},
);

const processDecision = node(
  function* (ctx: NodeContext, nodeInput: unknown) {
    const request = ctx.state.get('request') as TimeOffRequest;
    const decision = asDecision(nodeInput);

    let message: string;
    if (decision.approved) {
      const approvedDays = decision.approved_days ?? request.days;
      message =
        `Time Off Approved! ${approvedDays} out of ${request.days} days` +
        ' granted.';
    } else {
      message = 'Time Off Denied.';
    }

    yield createEvent({content: {role: 'model', parts: [{text: message}]}});
  },
  {name: 'process_decision'},
);

/**
 * Reads the manager's decision out of whatever the client sent: the structured
 * object, the same object as a JSON string, or a bare "approve"/"reject" word
 * typed at an interactive prompt.
 */
function asDecision(nodeInput: unknown): TimeOffDecision {
  if (typeof nodeInput === 'string') {
    try {
      return TimeOffDecisionSchema.parse(JSON.parse(nodeInput));
    } catch {
      const approved = nodeInput.trim().toLowerCase().startsWith('approve');
      return {approved, approved_days: null};
    }
  }
  return TimeOffDecisionSchema.parse(nodeInput);
}

export const rootAgent = new Workflow({
  name: 'request_input_advanced',
  edges: [['START', processRequest, evaluateRequest, processDecision]],
});
