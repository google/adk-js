/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/agent_in_workflow/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Agent in a workflow: a `task`-mode `LlmAgent` (`intake_agent`) chats to collect
 * a structured identity and completes via `finish_task`; a function node routes
 * on the result (retry the intake, or proceed); and a second `LlmAgent`
 * (`generate_instruction`) uses a `require_confirmation` tool. Faithful port of
 * Python `contributing/samples/workflows/agent_in_workflow`.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/agent_in_workflow/agent.ts
 * Provide a name + phone (use "Jane Doe" to pass the identity check). The
 * `find_orders` tool pauses for confirmation before running.
 */

import {
  createEvent,
  DEFAULT_ROUTE,
  FunctionTool,
  LlmAgent,
  node,
  NodeContext,
  Workflow,
} from '@google/adk';
import {z} from 'zod';

const patientIdentity = z.object({
  name: z.string().describe("The patient's full name."),
  phoneNumber: z.string().describe("The patient's phone number."),
});
type PatientIdentity = z.infer<typeof patientIdentity>;

/** Emits a plain display message (Python `Event(message=...)`). */
const message = (text: string) =>
  createEvent({content: {role: 'model', parts: [{text}]}});

// A task-mode agent: it chats to gather the identity and calls finish_task with
// the structured result, which becomes this node's output.
const intakeAgent = new LlmAgent({
  name: 'intake_agent',
  model: 'gemini-2.5-flash',
  mode: 'task',
  outputSchema: patientIdentity,
  instruction: `You are a medical lab intake assistant. Your job is to chat with
the user to get their full name and phone number. Do not make up
information. Once you have both, finish your task.
If identity check failed, ask for another name.`,
});

// Mocks checking the database for the patient. Routes back to intake_agent if
// the name is not Jane Doe.
const checkIdentity = node(
  (_ctx: NodeContext, identity: PatientIdentity) => {
    if (identity.name.toLowerCase() !== 'jane doe') {
      return createEvent({
        route: 'retry',
        content: {
          role: 'model',
          parts: [
            {
              text: `Could not find matching records for ${identity.name}. Let's try again.`,
            },
          ],
        },
      });
    }
    return message(`Hello ${identity.name}! Let me look up your orders.`);
  },
  {name: 'check_identity'},
);

// A tool that requires confirmation before it runs (HITL).
const findOrders = new FunctionTool({
  name: 'find_orders',
  description: "Finds the patient's lab orders.",
  execute: () => ['CBC (Complete Blood Count)', 'Lipid Panel'],
  requireConfirmation: true,
});

const generateInstruction = new LlmAgent({
  name: 'generate_instruction',
  model: 'gemini-2.5-flash',
  instruction: `You MUST call the find_orders tool to get the patient's actual
orders. Do not invent orders. After the tool returns, list the orders found and
then generate a concise instruction about how to prepare based on those orders.`,
  tools: [findOrders],
});

export const rootAgent = new Workflow({
  name: 'task_in_workflow',
  edges: [
    ['START', intakeAgent, checkIdentity],
    [
      checkIdentity,
      {
        retry: intakeAgent,
        // generate_instruction re-runs on resume so its tool-confirmation can
        // resolve after the user approves the find_orders call.
        [DEFAULT_ROUTE]: node(generateInstruction, {rerunOnResume: true}),
      },
    ],
  ],
});
