/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/agent_in_workflow.
 *
 * Both agent modes port directly: `mode: 'task'` gives `intake_agent` the
 * `finish_task` loop (it keeps chatting until its `outputSchema` is filled and
 * the parsed object becomes the node output), and the default `single_turn`
 * runs `generate_instruction` once. The back-edge routing map is spelled the
 * same, `DEFAULT_ROUTE` included.
 *
 * Surface differences:
 *   - `Event(message=..., route="retry")` is
 *     `createEvent({content, route: 'retry'})`.
 *   - Python coerces `node_input` into `PatientIdentity` from the parameter
 *     type hint; TS has no runtime hints, so the same contract goes on the
 *     node as `inputSchema`.
 *   - `FunctionTool(find_orders, require_confirmation=True)` takes the
 *     function's name/docstring in Python; TS states them explicitly.
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

import {PARITY_MODEL} from '../model.ts';

/** Output schema for the intake agent. */
const patientIdentitySchema = z.object({
  name: z.string().describe("The patient's full name."),
  phone_number: z.string().describe("The patient's phone number."),
});
type PatientIdentity = z.infer<typeof patientIdentitySchema>;

const intakeAgent = new LlmAgent({
  name: 'intake_agent',
  model: PARITY_MODEL,
  mode: 'task',
  outputSchema: patientIdentitySchema,
  instruction: `You are a medical lab intake assistant. Your job is to chat with
the user to get their full name and phone number. Do not make up
information. Once you have both, finish your task.
If identity check failed, ask for another name.
`,
});

/**
 * Mocks checking the database for the patient.
 *
 * Routes back to intake_agent if the name is not Jane Doe.
 */
const checkIdentity = node(
  function* (_ctx: NodeContext, nodeInput: PatientIdentity) {
    if (nodeInput.name.toLowerCase() !== 'jane doe') {
      yield createEvent({
        content: {
          role: 'model',
          parts: [
            {
              text:
                `Could not find matching records for ${nodeInput.name}. Let's` +
                ' try again.',
            },
          ],
        },
        route: 'retry',
      });
    } else {
      yield createEvent({
        content: {
          role: 'model',
          parts: [
            {text: `Hello ${nodeInput.name}! Let me look up your orders.`},
          ],
        },
      });
    }
  },
  {name: 'check_identity', inputSchema: patientIdentitySchema},
);

/** Finds orders for the patient. */
const findOrders = new FunctionTool({
  name: 'find_orders',
  description: 'Finds orders for the patient.',
  execute: () => ['CBC (Complete Blood Count)', 'Lipid Panel'],
  requireConfirmation: true,
});

const generateInstruction = new LlmAgent({
  name: 'generate_instruction',
  model: PARITY_MODEL,
  tools: [findOrders],
  instruction: `
Use the find_orders tool to get the patient's orders.
List the orders found, and then generate a concise instruction about how to prepare based on those orders.
`,
});

export const rootAgent = new Workflow({
  name: 'task_in_workflow',
  edges: [
    ['START', intakeAgent, checkIdentity],
    [checkIdentity, {retry: intakeAgent, [DEFAULT_ROUTE]: generateInstruction}],
  ],
});
