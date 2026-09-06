/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/node_as_tool.
 *
 * Both directions of the wrap exist here: an `LlmAgent` given a `BaseNode` in
 * `tools` auto-wraps it in a `NodeTool`, exactly as Python does, so a `@node`
 * function and a whole `Workflow` are both callable by the model.
 *
 * Surface differences:
 *   - Python derives the tool's parameter schema from the function SIGNATURE
 *     (`tier: str`) and its description from the docstring. TS introspects
 *     neither, and `NodeTool` refuses a node without one, so both are declared:
 *     `inputSchema` (zod) and `description`.
 *   - `ctx.resume_inputs.get(id)` is `ctx.resumeInputs[id]`.
 *   - `RequestInput(interrupt_id=...)` is `new RequestInput({interruptId})`.
 */
import {
  App,
  createEvent,
  LlmAgent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

// 1. Define schemas
const customerLookupArgsSchema = z.object({
  user_id: z.string().describe("The customer's unique identifier."),
});
type CustomerLookupArgs = z.infer<typeof customerLookupArgsSchema>;

// 2. Define a regular Node.
// This Node is wrapped as a NodeTool automatically by the Agent.
// As a NodeTool, it has the ability to yield intermediate Events during
// execution.
const calculateDiscount = node(
  function* (ctx: NodeContext, nodeInput: {tier: string}) {
    const {tier} = nodeInput;
    yield createEvent({
      content: {
        role: 'model',
        parts: [{text: `Checking discount rules for tier '${tier}'...`}],
      },
    });

    const resumeInput = ctx.resumeInputs['confirm_vip_discount'];
    let discount: string;
    if (tier.includes('VIP')) {
      if (!resumeInput) {
        yield new RequestInput({
          interruptId: 'confirm_vip_discount',
          message: `Apply VIP discount for tier '${tier}'?`,
        });
        return;
      }

      const userResponse =
        typeof resumeInput === 'object' && resumeInput !== null
          ? (resumeInput as {text?: unknown}).text
          : resumeInput;
      if (['yes', 'y', 'true'].includes(String(userResponse).toLowerCase())) {
        discount = '20% off';
      } else {
        discount = '5% off (VIP declined)';
      }
    } else {
      discount = '5% off';
    }

    yield discount;
  },
  {
    name: 'calculate_discount',
    description:
      'Calculates the discount percentage based on customer tier.\n\n' +
      'Args:\n' +
      "  tier: The customer's membership tier (e.g., VIP, Standard).",
    inputSchema: z.object({
      tier: z
        .string()
        .describe("The customer's membership tier (e.g., VIP, Standard)."),
    }),
    rerunOnResume: true,
  },
);

// 3. Define a Workflow.
// This Workflow is wrapped as a NodeTool automatically by the Agent.
const lookupCustomerData = node(
  (_ctx: NodeContext, nodeInput: CustomerLookupArgs) => ({
    user_id: nodeInput.user_id,
    tier: 'Verified VIP Member',
  }),
  {name: 'lookup_customer_data'},
);

const customerLookupWorkflow = new Workflow({
  name: 'customer_lookup_workflow',
  description: 'Looks up customer status and tier by user_id.',
  inputSchema: customerLookupArgsSchema,
  edges: [['START', lookupCustomerData]],
});

// 4. Define the Agent that uses both Node and Workflow as tools.
export const rootAgent = new LlmAgent({
  name: 'customer_service_agent',
  model: PARITY_MODEL,
  instruction: `
    You are a customer service assistant.
    1. First, call \`customer_lookup_workflow\` using the user_id to get their membership tier.
    2. Then, call \`calculate_discount\` node with that tier to find out what discount they get.
    Summarize these details for the customer.
    `,
  tools: [customerLookupWorkflow, calculateDiscount],
});

// Wrap the agent in an App and enable resumability. This is required because
// the `calculate_discount` tool yields a RequestInput event which pauses
// execution, and we need to resume the agent in a subsequent turn.
export const app = new App({
  name: 'node_as_tool',
  rootAgent,
  resumabilityConfig: {isResumable: true},
});
