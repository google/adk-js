/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic workflows: get started
 * https://adk.dev/graphs/dynamic/#get-started
 *
 * A dynamic workflow drops the static edge graph and orchestrates in plain
 * code: an outer node calls `ctx.runNode(child, input)` to execute children in
 * whatever order your loops and conditionals dictate.
 *
 * Two things to know going in:
 *   - `ctx.runNode()` resolves to a node RESULT, so read `.output`.
 *   - An orchestrator that calls `ctx.runNode` must set `rerunOnResume: true`,
 *     so its body re-runs on resume and already-finished children are replayed
 *     from their checkpoints rather than executed again.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/dynamic/get_started/agent.ts
 */

import {node, NodeContext, WorkflowAgent} from '@google/adk';

const myNode = node(() => 'Hello World', {name: 'hello_node'});

const myWorkflow = node(
  async (ctx: NodeContext, _nodeInput: string) => {
    // runNode executes a node and resolves to its result.
    const result = await ctx.runNode(myNode, 'hello');
    return result.output;
  },
  {name: 'my_workflow', rerunOnResume: true},
);

export const rootAgent = new WorkflowAgent({
  name: 'root_agent',
  edges: [['START', myWorkflow]],
});
