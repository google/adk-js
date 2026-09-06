/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/hitl/human_in_loop.
 *
 * The HITL mechanism here is only `LongRunningFunctionTool`: `ask_for_approval`
 * returns a pending ticket and its call id is surfaced as a long-running tool
 * id, so a caller can post the manager's decision later. Nothing in the agent
 * pauses on a framework interrupt, which makes this the one sample in the
 * family both CLIs can script identically.
 *
 * Python's docstrings are the tool descriptions, so they are copied verbatim
 * into `description`.
 */
import {FunctionTool, LlmAgent, LongRunningFunctionTool} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const reimburse = new FunctionTool({
  name: 'reimburse',
  description: 'Reimburse the amount of money to the employee.',
  parameters: z.object({
    purpose: z.string(),
    amount: z.number(),
  }),
  execute: () => ({
    status: 'ok',
  }),
});

const askForApproval = new LongRunningFunctionTool({
  name: 'ask_for_approval',
  description: 'Ask for approval for the reimbursement.',
  parameters: z.object({
    purpose: z.string(),
    amount: z.number(),
  }),
  execute: ({amount}) => ({
    status: 'pending',
    amount,
    ticketId: 'reimbursement-ticket-001',
  }),
});

export const rootAgent = new LlmAgent({
  name: 'reimbursement_agent',
  model: PARITY_MODEL,
  instruction: `
      You are an agent whose job is to handle the reimbursement process for
      the employees. If the amount is less than $100, you will automatically
      approve the reimbursement.

      If the amount is greater than $100, you will
      ask for approval from the manager. If the manager approves, you will
      call reimburse() to reimburse the amount to the employee. If the manager
      rejects, you will inform the employee of the rejection.
`,
  tools: [reimburse, askForApproval],
  generateContentConfig: {temperature: 0.1},
});
