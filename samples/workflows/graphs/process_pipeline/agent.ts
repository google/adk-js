/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build processes with graphs
 * https://adk.dev/graphs/#build-processes-with-graphs
 *
 * A prompt-based agent turned into a graph: one agent classifies the message,
 * a router node emits the categories as routes, and the graph dispatches to the
 * matching handler(s). Because the classifier may return more than one
 * category, the router emits an ARRAY of routes — every matching branch fires.
 *
 * REQUIRES an API key (classification calls a live model). Set GEMINI_API_KEY:
 *   npm run sample -- samples/workflows/graphs/process_pipeline/agent.ts
 * Try "the checkout page throws a 500" or "where is my parcel?".
 */

import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';

const processMessage = new LlmAgent({
  name: 'process_message',
  model: 'gemini-flash-latest',
  instruction: `Classify user message into either "BUG", "CUSTOMER_SUPPORT",
      or "LOGISTICS". If you think a message applies to more than one category,
      reply with a comma separated list of categories.
      Reply with the categories only, nothing else.`,
});

// A route ARRAY fires every branch whose route key matches one of the listed
// values (multi-route dispatch), rather than just the first match.
const router = node(
  (_ctx: NodeContext, nodeInput: string) =>
    createEvent({
      route: nodeInput
        .split(',')
        .map((route) => route.trim().toUpperCase())
        .filter(Boolean),
    }),
  {name: 'router'},
);

/** Emits a user-facing message: `content`, with no `output`. */
const message = (text: string) =>
  createEvent({content: {role: 'model', parts: [{text}]}});

const response1Bug = node(() => message('Handling bug...'), {
  name: 'response_1_bug',
});
const response2Support = node(() => message('Handling customer support...'), {
  name: 'response_2_support',
});
const response3Logistics = node(() => message('Handling logistics...'), {
  name: 'response_3_logistics',
});

export const rootAgent = new Workflow({
  name: 'routing_workflow',
  edges: [
    ['START', processMessage, router],
    [
      router,
      {
        BUG: response1Bug,
        CUSTOMER_SUPPORT: response2Support,
        LOGISTICS: response3Logistics,
      },
    ],
  ],
});
