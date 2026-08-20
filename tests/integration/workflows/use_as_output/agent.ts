/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * use_as_output: an orchestrator runs a sub-agent with `useAsOutput`, so the
 * sub-agent's result becomes the node's output. One-to-one port of Python
 * `contributing/samples/workflows/use_as_output/agent.py`.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- tests/integration/workflows/use_as_output/agent.ts
 * Paste some text to summarize.
 */

import {LlmAgent, node, NodeContext, Workflow} from '@google/adk';

const summarizer = new LlmAgent({
  name: 'summarizer',
  model: 'gemini-2.5-flash',
  instruction: 'Summarize the following text in one sentence.',
});

const orchestrate = node(
  async (ctx: NodeContext, nodeInput: string) => {
    const child = await ctx.runNode(summarizer, nodeInput, {useAsOutput: true});
    return child.output;
  },
  {name: 'orchestrate', rerunOnResume: true},
);

const finalize = node(
  (_c: NodeContext, nodeInput: string) => `final: ${nodeInput}`,
  {
    name: 'finalize',
  },
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', orchestrate, finalize]],
});
