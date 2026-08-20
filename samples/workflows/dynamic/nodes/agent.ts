/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nodes, and the workflows that compose them
 * https://adk.dev/graphs/dynamic/#node
 * https://adk.dev/graphs/dynamic/#workflows
 *
 * The two ways to build a node:
 *
 *   node(fn, options)                     the factory form
 *   new FunctionNode(name, fn, config)    the explicit constructor
 *
 * Reach for the explicit constructor when you are wrapping a function from
 * another library, need several differently-configured nodes from one function,
 * or keep node references in a registry for advanced orchestration.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/dynamic/nodes/agent.ts
 */

import {FunctionNode, node, NodeContext, Workflow} from '@google/adk';

/** The plain function both node forms wrap. */
function myFunctionNode(_ctx: NodeContext, nodeInput: unknown): string {
  return `Hello ${nodeInput ?? 'World'}`;
}

// Form 1 — the `node()` factory.
const helloNode = node(myFunctionNode, {name: 'hello_node'});

// Form 2 — the explicit constructor, same function, different configuration.
const successNode = new FunctionNode('hello', myFunctionNode, {
  rerunOnResume: true,
});

const myFormattingNode = node(
  (_ctx: NodeContext, nodeInput: string) => `>> ${nodeInput.trim()} <<`,
  {name: 'my_formatting_node'},
);

// The orchestrator: run children in order and return the last result.
const myWorkflow = node(
  async (ctx: NodeContext, nodeInput: unknown) => {
    const greeted = await ctx.runNode(helloNode, nodeInput);
    const again = await ctx.runNode(successNode, greeted.output);
    const formatted = await ctx.runNode(myFormattingNode, again.output);
    return formatted.output;
  },
  {name: 'my_workflow', rerunOnResume: true},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', myWorkflow]],
});
