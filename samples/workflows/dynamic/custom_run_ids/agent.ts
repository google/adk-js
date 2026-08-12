/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom execution IDs
 * https://adk.dev/graphs/dynamic/#custom-execution-ids
 *
 * ADK gives every child execution a deterministic id derived from the parent id
 * and a per-node-name counter ("1", "2", "3", ...). Those ids are how a resumed
 * or retried workflow recognises work that already completed and skips it.
 *
 * Warning: avoid custom run ids. Because ids drive checkpoint lookup, a
 * non-deterministic or reshuffled id makes a resume re-run work it should have
 * skipped (or skip work it should have re-run). The one legitimate case is a
 * REORDERABLE collection, where position is not stable but identity is — key
 * the run id off the item's own id, as below.
 *
 * A custom run id must contain at least one non-numeric character so it cannot
 * collide with the auto-generated sequential ids.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/dynamic/custom_run_ids/agent.ts
 */

import {node, NodeContext, WorkflowAgent} from '@google/adk';

interface Order {
  orderId: string;
  cartItems: string[];
}

/** Stands in for loading orders from a database. */
async function getOrders(): Promise<Order[]> {
  return [
    {orderId: 'a91', cartItems: ['keyboard', 'mouse']},
    {orderId: 'b02', cartItems: ['monitor']},
    {orderId: 'c73', cartItems: ['dock', 'cable', 'hub']},
  ];
}

const processOrder = node(
  (_ctx: NodeContext, order: Order) =>
    `order ${order.orderId}: ${order.cartItems.length} item(s) shipped`,
  {name: 'process_order'},
);

const processAllOrders = node(
  async (ctx: NodeContext) => {
    const orders = await getOrders();

    const processTasks = orders.map((order) =>
      // Use runId to provide a custom identifier. It must contain at least one
      // non-numeric character to avoid colliding with the auto-generated
      // sequential numeric ids.
      ctx.runNode(processOrder, order, {runId: `order-${order.orderId}`}),
    );

    const results = await Promise.all(processTasks);
    return results.map((result) => result.output).join('\n');
  },
  {name: 'process_all_orders', rerunOnResume: true},
);

export const rootAgent = new WorkflowAgent({
  name: 'root_agent',
  edges: [['START', processAllOrders]],
});
