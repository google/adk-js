/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, LlmAgent, LongRunningFunctionTool} from '@google/adk';
import {z} from 'zod';
import {runAndCapture} from '../../../state_dump_utils.ts';
// import {
//   GeminiWithMockResponses,
//   RawGenerateContentResponse,
// } from '../../../test_case_utils.js';
// import modelResponses from './model_responses.json' with {type: 'json'};

const reimburseTool = new FunctionTool({
  name: 'reimburse',
  description: 'Reimburse the amount of money to the employee.',
  parameters: z.object({
    purpose: z.string().describe('The purpose of the reimbursement.'),
    amount: z.number().describe('The amount to reimburse.'),
  }),
  execute: async () => {
    return {
      status: 'ok',
    };
  },
});

const askForApprovalTool = new LongRunningFunctionTool({
  name: 'ask_for_approval',
  description: 'Ask for approval for the reimbursement.',
  parameters: z.object({
    purpose: z.string().describe('The purpose of the reimbursement.'),
    amount: z.number().describe('The amount to reimburse.'),
  }),
  execute: async ({amount}: {purpose: string; amount: number}) => {
    return {
      status: 'pending',
      amount: amount,
      ticketId: 'reimbursement-ticket-001',
    };
  },
});

export const rootAgent = new LlmAgent({
  name: 'reimbursement_agent',
  model: 'gemini-3-flash-preview',
  description: 'Reimbursement agent that handles employee reimbursements.',
  instruction: `
      You are an agent whose job is to handle the reimbursement process for
      the employees. If the amount is less than $100, you will automatically
      approve the reimbursement.

      If the amount is greater than $100, you will
      ask for approval from the manager. If the manager approves, you will
      call reimburse() to reimburse the amount to the employee. If the manager
      rejects, you will inform the employee of the rejection.
  `,
  tools: [reimburseTool, askForApprovalTool],
  generateContentConfig: {
    temperature: 0.1,
  },
});

runAndCapture(rootAgent, 'Please reimburse $200 for conference travel', {
  modelResponses: 'model_responses.json',
}).then(() => {
  console.log('Done');
});
