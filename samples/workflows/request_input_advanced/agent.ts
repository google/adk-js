/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Advanced request-input: small requests are auto-approved (no interrupt);
 * larger ones pause for manager approval. Mirrors Python
 * `workflows/request_input_advanced`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/request_input_advanced/agent.ts
 * Type a number of days. <=1 auto-approves; >1 asks for approval ("yes"/"no").
 */

import {
  node,
  NodeContext,
  RequestInput,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

interface Decision {
  approved: boolean;
  approvedDays: number;
}

const processRequest = node(
  (_c: NodeContext, input: string) => {
    const days = Math.max(0, parseInt(String(input).trim(), 10) || 1);
    return {days, reason: 'time off'};
  },
  {name: 'process_request'},
);

const evaluateRequest = node(
  (
    ctx: NodeContext,
    req: {days: number; reason: string},
  ): Decision | RequestInput => {
    if (req.days <= 1) {
      return {approved: true, approvedDays: req.days}; // auto-approve
    }
    const decision = ctx.resumeInputs['manager_approval'];
    if (decision === undefined) {
      return new RequestInput({
        interruptId: 'manager_approval',
        message: `Approve ${req.days} day(s) off for "${req.reason}"? Reply "yes" or "no".`,
      });
    }
    const approved = String(decision).trim().toLowerCase().startsWith('y');
    return {approved, approvedDays: approved ? req.days : 0};
  },
  {name: 'evaluate_request'},
);

const processDecision = node(
  (_c: NodeContext, d: Decision) =>
    d.approved ? `Approved for ${d.approvedDays} day(s).` : 'Request denied.',
  {name: 'process_decision'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'request_input_advanced',
    edges: [['START', processRequest, evaluateRequest, processDecision]],
  }),
);
