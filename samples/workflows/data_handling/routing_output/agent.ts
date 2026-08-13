/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Routing output
 * https://adk.dev/graphs/data-handling/#routing-output
 *
 * `route` is the event field that drives conditional edge dispatch — it is
 * independent of `output`, so a router can select a branch AND forward a payload
 * in the same event. Route values may be strings, numbers, or booleans, and
 * `DEFAULT_ROUTE` catches everything no other branch matched.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/data_handling/routing_output/agent.ts
 * Try "the app crashed" (BUG) or "where is my order?" (falls through).
 */

import {
  createEvent,
  DEFAULT_ROUTE,
  node,
  NodeContext,
  WorkflowAgent,
} from '@google/adk';

const router = node(
  (_ctx: NodeContext, nodeInput: string) =>
    createEvent({
      route: /bug|crash|error/i.test(nodeInput) ? 'BUG' : 'OTHER',
      // Forwarded to whichever branch fires.
      output: nodeInput,
    }),
  {name: 'router'},
);

const handleBug = node(
  (_ctx: NodeContext, nodeInput: string) => `Filed a bug for: ${nodeInput}`,
  {name: 'handle_bug'},
);

const handleAnythingElse = node(
  (_ctx: NodeContext, nodeInput: string) => `No bug detected in: ${nodeInput}`,
  {name: 'handle_anything_else'},
);

export const rootAgent = new WorkflowAgent({
  name: 'routing_output_workflow',
  edges: [
    ['START', router],
    [
      router,
      {
        BUG: handleBug,
        // Fires when no other route on this node matched.
        [DEFAULT_ROUTE]: handleAnythingElse,
      },
    ],
  ],
});
