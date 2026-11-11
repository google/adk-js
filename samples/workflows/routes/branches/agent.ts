/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Route branches and conditional execution
 * https://adk.dev/graphs/routes/#route-branches-and-conditional-execution
 *
 * Branching is a node that emits a `route`, plus an edge row mapping each route
 * value to the node that handles it. A branch target can be anything node-like:
 * `task_B_node` here is an `LlmAgent`, `task_C_node` a plain function.
 *
 * The docs page leaves `task_A_node` and `condition()` undefined; this sample
 * defines them (the condition is "the input mentions a number").
 *
 * REQUIRES an API key when the RUN_TASK_B branch is taken (it calls a live
 * model). Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/routes/branches/agent.ts
 * Try "tell me about graphs" (task B) or "give me 3 facts" (task C).
 */

import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';

const taskANode = node(
  (_ctx: NodeContext, nodeInput: string) => nodeInput.trim(),
  {name: 'task_A_node'},
);

/** Stands in for the docs' unspecified `condition()`. */
const condition = (nodeInput: string) => /\d/.test(nodeInput);

/** Routes to task B or C based on nodeInput. */
const router = node(
  (_ctx: NodeContext, nodeInput: string) =>
    condition(nodeInput)
      ? createEvent({route: 'RUN_TASK_C', output: nodeInput})
      : createEvent({route: 'RUN_TASK_B', output: nodeInput}),
  {name: 'router'},
);

// An agent to execute node B.
const taskBNode = new LlmAgent({
  name: 'task_B_agent',
  model: 'gemini-flash-latest',
  instruction: 'Answer the user in a single short sentence.',
});

// A FunctionNode to execute node C.
const taskCNode = node(() => 'Task C completed', {name: 'task_C_node'});

export const rootAgent = new Workflow({
  name: 'routing_workflow',
  edges: [
    ['START', taskANode, router],
    [
      router,
      {
        // "route value": node_to_run
        RUN_TASK_B: taskBNode,
        RUN_TASK_C: taskCNode,
      },
    ],
  ],
});
