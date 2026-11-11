/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node-as-tool: an `LlmAgent` uses a `Workflow` AND a function node as tools.
 * The framework auto-wraps each as a `NodeTool`, so the model can call them like
 * any other tool; a node may even pause for input (HITL) mid-tool-call.
 * One-to-one port of Python
 * `contributing/samples/workflows/node_as_tool/agent.py`.
 *
 * `customer_lookup_workflow` looks up a customer's tier; `calculate_discount`
 * (a node) streams a status message and, for VIP tiers, raises a `RequestInput`
 * to confirm the discount — pausing the agent until the user responds.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- tests/integration/workflows/node_as_tool/agent.ts
 * Turn 1: "Look up user c123 and tell me my discount."
 * Turn 2 (VIP): resume by answering the confirmation (a function response to the
 * `confirm_vip_discount` interrupt, e.g. via the web UI).
 */

import {
  App,
  createEvent,
  createResumabilityConfig,
  LlmAgent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
} from '@google/adk';
import {z} from 'zod';

const customerLookupArgs = z.object({
  user_id: z.string().describe("The customer's unique identifier."),
});

/** Python's `Event(message=...)` content shape (role `user`). */
const message = (text: string) =>
  createEvent({content: {role: 'user', parts: [{text}]}});

const calculateDiscount = node(
  function* (ctx: NodeContext, args: {tier: string}) {
    yield message(`Checking discount rules for tier '${args.tier}'...`);

    const resumeInput = ctx.resumeInputs['confirm_vip_discount'];
    if (args.tier.includes('VIP')) {
      if (!resumeInput) {
        yield new RequestInput({
          interruptId: 'confirm_vip_discount',
          message: `Apply VIP discount for tier '${args.tier}'?`,
        });
        return;
      }

      const userResponse =
        typeof resumeInput === 'object' && resumeInput !== null
          ? (resumeInput as {text?: string}).text
          : resumeInput;
      yield ['yes', 'y', 'true'].includes(String(userResponse).toLowerCase())
        ? '20% off'
        : '5% off (VIP declined)';
    } else {
      yield '5% off';
    }
  },
  {
    name: 'calculate_discount',
    description: 'Calculates the discount percentage based on customer tier.',
    inputSchema: z.object({
      tier: z
        .string()
        .describe("The customer's membership tier (e.g., VIP, Standard)."),
    }),
    outputSchema: z.string(),
    rerunOnResume: true,
  },
);

const lookupCustomerData = node(
  (_ctx: NodeContext, nodeInput: {user_id: string}) => ({
    user_id: nodeInput.user_id,
    tier: 'Verified VIP Member',
  }),
  {name: 'lookup_customer_data'},
);

const customerLookupWorkflow = new Workflow({
  name: 'customer_lookup_workflow',
  description: 'Looks up customer status and tier by user_id.',
  inputSchema: customerLookupArgs,
  edges: [['START', lookupCustomerData]],
});

export const rootAgent = new LlmAgent({
  name: 'customer_service_agent',
  model: 'gemini-2.5-flash',
  instruction: `
    You are a customer service assistant.
    1. First, call \`customer_lookup_workflow\` using the user_id to get their membership tier.
    2. Then, call \`calculate_discount\` node with that tier to find out what discount they get.
    Summarize these details for the customer.
    `,
  tools: [customerLookupWorkflow, calculateDiscount],
});

export const app = new App({
  name: 'node_as_tool',
  rootAgent,
  resumabilityConfig: createResumabilityConfig({isResumable: true}),
});
