/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data handling in a dynamic workflow
 * https://adk.dev/graphs/dynamic/#data-handling
 *
 * Passing data in a dynamic workflow is simpler than in a graph: `ctx.runNode()`
 * hands you the child's result directly, so there are no session-state keys to
 * read and write just to move a value one step downstream. It resolves to a
 * node result, so read `.output`.
 *
 * REQUIRES an API key (the draft agent calls a live model). Set GEMINI_API_KEY:
 *   npm run sample -- samples/workflows/dynamic/data_handling/agent.ts
 * Try "a short paragraph about why graphs beat long prompts".
 */

import {LlmAgent, node, NodeContext, WorkflowAgent} from '@google/adk';

const draftAgent = node(
  new LlmAgent({
    name: 'draft_agent',
    model: 'gemini-flash-latest',
    instruction: 'Write a short draft for the user request.',
  }),
);

const formatFunctionNode = node(
  (_ctx: NodeContext, rawDraft: string) =>
    rawDraft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `| ${line}`)
      .join('\n'),
  {name: 'format_function_node'},
);

const editorialWorkflow = node(
  async (ctx: NodeContext, userRequest: string) => {
    // Agent node generates output.
    const rawDraft = await ctx.runNode(draftAgent, userRequest);

    // Function node formats text.
    const formattedText = await ctx.runNode(
      formatFunctionNode,
      rawDraft.output,
    );

    return formattedText.output;
  },
  {name: 'editorial_workflow', rerunOnResume: true},
);

export const rootAgent = new WorkflowAgent({
  name: 'root_agent',
  edges: [['START', editorialWorkflow]],
});
