/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/hitl/human_tool_confirmation.
 *
 * Both confirmation styles the sample shows port one-for-one:
 *   - `FunctionTool(reimburse, require_confirmation=confirmation_threshold)`
 *     becomes `requireConfirmation: (input) => ...`, the same predicate over the
 *     validated call arguments.
 *   - `tool_context.request_confirmation(hint=..., payload=...)` becomes
 *     `toolContext.requestConfirmation({hint, payload})`, and the decision comes
 *     back on `toolContext.toolConfirmation` on the re-invocation.
 *
 * `App(resumability_config=ResumabilityConfig(is_resumable=True))` becomes
 * `new App({resumabilityConfig: {isResumable: true}})`, so the app name — which
 * is what both CLIs use as the session app name — stays identical.
 */
import {App, Context, FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const reimburse = new FunctionTool({
  name: 'reimburse',
  description: 'Reimburse the employee for the given amount.',
  parameters: z.object({
    amount: z.number(),
  }),
  execute: () => ({status: 'ok'}),
  // Set requireConfirmation to true or a callable to require user
  // confirmation for the tool call. This is an easier way to get user
  // confirmation if the tool just need a boolean confirmation.
  // Returns true if the amount is greater than 1000.
  requireConfirmation: async ({amount}) => amount > 1000,
});

const requestTimeOff = new FunctionTool({
  name: 'request_time_off',
  description: 'Request day off for the employee.',
  parameters: z.object({
    days: z.number().int(),
  }),
  execute: ({days}, toolContext?: Context) => {
    if (days <= 0) {
      return {status: 'Invalid days to request.'};
    }

    if (days <= 2) {
      return {
        status: 'ok',
        approved_days: days,
      };
    }

    const toolConfirmation = toolContext?.toolConfirmation;
    if (!toolConfirmation) {
      toolContext?.requestConfirmation({
        hint:
          'Please approve or reject the tool call request_time_off() by' +
          ' responding with a FunctionResponse with an expected' +
          ' ToolConfirmation payload.',
        payload: {
          approved_days: 0,
        },
      });
      return {status: 'Manager approval is required.'};
    }

    if (!toolConfirmation.confirmed) {
      return {status: 'The time off request is rejected.', approved_days: 0};
    }

    // The payload is optional: a client may confirm with just
    // {'confirmed': true}, which approves the days that were asked for. When the
    // payload is present it narrows the approval.
    const payload = (toolConfirmation.payload ?? {}) as {
      approved_days?: number;
    };
    const approvedDays = Math.min(payload.approved_days ?? days, days);
    if (approvedDays === 0) {
      return {status: 'The time off request is rejected.', approved_days: 0};
    }
    return {
      status: 'ok',
      approved_days: approvedDays,
    };
  },
});

export const rootAgent = new LlmAgent({
  name: 'time_off_agent',
  model: PARITY_MODEL,
  instruction: `
    You are a helpful assistant that can help employees with reimbursement and time off requests.
    - Use the \`reimburse\` tool for reimbursement requests.
    - Use the \`request_time_off\` tool for time off requests.
    - Prioritize using tools to fulfill the user's request.
    - Always respond to the user with the tool results.
    `,
  tools: [reimburse, requestTimeOff],
  generateContentConfig: {temperature: 0.1},
});

export const app = new App({
  name: 'human_tool_confirmation',
  rootAgent,
  // Set the resumability config to enable resumability.
  resumabilityConfig: {
    isResumable: true,
  },
});
