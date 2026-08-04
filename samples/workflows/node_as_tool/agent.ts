/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node-as-tool: an `LlmAgent` uses a `Workflow` AND a function node as tools.
 * The framework auto-wraps each as a `NodeTool`, so the model can call them like
 * any other tool; a node may even pause for input (HITL) mid-tool-call. Faithful
 * port of Python `contributing/samples/workflows/node_as_tool`.
 *
 * `customer_lookup_workflow` looks up a customer's tier; `calculate_discount`
 * (a node) streams a status message and, for VIP tiers, raises a `RequestInput`
 * to confirm the discount — pausing the agent until the user responds.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/node_as_tool/agent.ts
 * Turn 1: "Look up user u123 and tell me my discount."
 * Turn 2 (VIP): resume by answering the confirmation (a function response to the
 * `confirm_vip_discount` interrupt, e.g. via the web UI).
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

const customerLookupArgs = z.object({
  userId: z.string().describe("The customer's unique identifier."),
});

/** Emits a plain display message (Python `Event(message=...)`). */
const message = (text: string) =>
  createEvent({content: {role: 'model', parts: [{text}]}});

// A node exposed as a tool. It streams an intermediate message and, for VIP
// tiers, pauses (RequestInput) to confirm the discount. rerunOnResume=true so it
// re-runs on resume and reads the reply from ctx.resumeInputs.
const calculateDiscount = node(
  function* (ctx: NodeContext, args: {tier: string}) {
    yield message(`Checking discount rules for tier '${args.tier}'...`);

    const resume = ctx.resumeInputs['confirm_vip_discount'];
    if (args.tier.includes('VIP')) {
      if (resume === undefined) {
        yield new RequestInput({
          interruptId: 'confirm_vip_discount',
          message: `Apply VIP discount for tier '${args.tier}'?`,
        });
        return;
      }
      const answer =
        typeof resume === 'object' && resume !== null
          ? (resume as {text?: string}).text
          : resume;
      // Same affirmative normalization the other HITL samples use.
      yield ['yes', 'y', 'true', 'approve', 'approved'].includes(
        String(answer).trim().toLowerCase(),
      )
        ? '20% off'
        : '5% off (VIP declined)';
    } else {
      yield '5% off';
    }
  },
  {
    name: 'calculate_discount',
    description:
      'Calculates the discount percentage based on the customer tier.',
    inputSchema: z.object({
      tier: z.string().describe('The customer membership tier (e.g. VIP).'),
    }),
    rerunOnResume: true,
  },
);

// A Workflow exposed as a tool: looks up customer status/tier by user_id.
const lookupCustomerData = node(
  (_ctx: NodeContext, args: {userId: string}) => ({
    userId: args.userId,
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

// The agent uses both the Workflow and the node as tools.
export const rootAgent = new LlmAgent({
  name: 'customer_service_agent',
  model: 'gemini-2.5-flash',
  instruction: `
    You are a customer service assistant.
    1. First, call \`customer_lookup_workflow\` using the user_id to get their membership tier.
    2. Then, call \`calculate_discount\` with that tier to find out what discount they get.
    Summarize these details for the customer.
    `,
  tools: [customerLookupWorkflow, calculateDiscount],
});
