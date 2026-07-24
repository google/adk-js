/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * use_as_output: a node runs a sub-node via `ctx.runNode(..., {useAsOutput})`
 * so the sub-node's result becomes the caller's output. Mirrors Python
 * `workflows/use_as_output`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/use_as_output/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

// Stands in for an LlmAgent summarizer (kept function-based to run offline).
const summarizer = node(
  (_c: NodeContext, text: string) =>
    `Summary: ${String(text).split(/\s+/).slice(0, 6).join(' ')}...`,
  {name: 'summarizer'},
);

const orchestrate = node(
  async (ctx: NodeContext, input: string) => {
    const child = await ctx.runNode(summarizer, input, {useAsOutput: true});
    return child.output;
  },
  {name: 'orchestrate'},
);

const finalize = node(
  (_c: NodeContext, summary: string) => `final: ${summary}`,
  {name: 'finalize'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'use_as_output',
    edges: [['START', orchestrate, finalize]],
  }),
);
