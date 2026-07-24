/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic fan-out/fan-in: an imperative entry runs many nodes concurrently via
 * `Promise.all(ctx.runNode(...))` and aggregates the results. Mirrors Python
 * `workflows/dynamic_fan_out_fan_in`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/dynamic_fan_out_fan_in/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

const square = node(
  (_c: NodeContext, n: number) => (n as number) * (n as number),
  {
    name: 'square',
  },
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'dynamic_fan_out_fan_in',
    dynamicEntry: async (ctx) => {
      const items = [1, 2, 3, 4, 5];
      const results = await Promise.all(
        items.map((n, i) => ctx.runNode(square, n, {runId: `sq-${i}`})),
      );
      const squares = results.map((r) => r.output as number);
      const total = squares.reduce((a, b) => a + b, 0);
      return `Squares: ${squares.join(', ')} (sum = ${total})`;
    },
  }),
);
