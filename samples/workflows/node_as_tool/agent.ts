/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node-as-tool: a node imperatively calls other nodes via `ctx.runNode()`.
 * Mirrors Python `workflows/node_as_tool`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/node_as_tool/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

const add = node(
  (_c: NodeContext, args: {a: number; b: number}) => args.a + args.b,
  {name: 'add'},
);

const orchestrator = node(
  async (ctx: NodeContext) => {
    const first = await ctx.runNode(add, {a: 2, b: 3});
    const second = await ctx.runNode(add, {a: 10, b: first.output as number});
    return `2 + 3 = ${first.output}, then + 10 = ${second.output}`;
  },
  {name: 'orchestrator'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'node_as_tool',
    edges: [['START', orchestrator]],
  }),
);
