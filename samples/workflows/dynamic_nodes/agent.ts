/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic nodes: an imperative entry drives execution with plain control flow
 * and `ctx.runNode()`. Mirrors Python `workflows/dynamic_nodes`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/dynamic_nodes/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

const step = node((_c: NodeContext, n: number) => (n as number) + 1, {
  name: 'step',
});

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'dynamic_nodes',
    dynamicEntry: async (ctx) => {
      let value = 0;
      const trace: number[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await ctx.runNode(step, value, {runId: `step-${i}`});
        value = result.output as number;
        trace.push(value);
      }
      return `Ran ${trace.length} dynamic steps: ${trace.join(' -> ')}`;
    },
  }),
);
