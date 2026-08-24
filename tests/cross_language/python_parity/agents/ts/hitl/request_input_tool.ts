/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/hitl/request_input_tool.
 *
 * "Pattern B": the built-in request-input tool handed to a plain LlmAgent, so
 * the model itself decides to pause and builds the `response_schema` for the
 * details it is missing. `google.adk.tools.request_input` is
 * `requestInputTool` in adk-js — the same `adk_request_input` long-running
 * call, with the same snake_case `response_schema` argument on the wire.
 *
 * The Pydantic `SupportTicket` becomes the equivalent zod object; adk-js
 * validates the model's arguments against it before `execute`, which is what
 * Python's model coercion does.
 */
import {FunctionTool, LlmAgent, requestInputTool} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

/** Details of the IT support ticket to be created. */
const SupportTicket = z.object({
  title: z.string().describe('A brief summary of the issue.'),
  description: z.string().describe('Detailed explanation of the problem.'),
  priority: z
    .string()
    .default('MEDIUM')
    .describe('Ticket priority: LOW, MEDIUM, HIGH, or CRITICAL.'),
  category: z
    .string()
    .describe(
      'Issue category, e.g., billing, technical, account, or database.',
    ),
});

const createSupportTicket = new FunctionTool({
  name: 'create_support_ticket',
  description: 'Create a support ticket in the IT ticketing system.',
  parameters: z.object({
    ticket: SupportTicket,
  }),
  execute: ({ticket}) => ({
    status: 'success',
    message:
      `Successfully created ticket '${ticket.title}'` +
      ` [Category: ${ticket.category}, Priority: ${ticket.priority}].`,
    ticket_id: 'INC-98471',
  }),
});

export const rootAgent = new LlmAgent({
  name: 'support_assistant_agent',
  model: PARITY_MODEL,
  instruction: `
      You are a helpful IT support assistant responsible for creating support tickets.
      When the user requests to create or file a ticket:
      1. Identify which ticket details (title, description, priority, category) are already provided in the conversation.
      2. If any mandatory details are missing, call the \`adk_request_input\` tool.
      3. When calling \`adk_request_input\`, you must construct a dynamic JSON \`response_schema\` (type: "object") that ONLY requests the missing details, and specify a helpful message explaining what is needed.
      4. Once all details are gathered, call \`create_support_ticket\` with the complete SupportTicket details.
    `,
  tools: [createSupportTicket, requestInputTool],
  generateContentConfig: {temperature: 0.1},
});
