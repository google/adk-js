/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/use_as_output.
 *
 * `ctx.runNode(child, input, {useAsOutput: true})` is the TS spelling of
 * Python's `ctx.run_node(child, node_input=..., use_as_output=True)`: the
 * child's output replaces the orchestrator's and flows on to `finalize`.
 *
 * Two surface differences:
 *   - Python's `@node(rerun_on_resume=True)` decorator is `node(fn, {name,
 *     rerunOnResume: true})` here — TS has no decorator form.
 *   - `ctx.runNode` resolves to a node *result*, so the output is read off
 *     `.output` rather than being the awaited value itself.
 */
import {LlmAgent, node, NodeContext, START, Workflow} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

const summarizer = new LlmAgent({
  name: 'summarizer',
  model: PARITY_MODEL,
  instruction: 'Summarize the following text in one sentence.',
});

const orchestrate = node(
  async (ctx: NodeContext, nodeInput: string) => {
    const result = await ctx.runNode(summarizer, nodeInput, {
      useAsOutput: true,
    });
    return result.output;
  },
  {name: 'orchestrate', rerunOnResume: true},
);

const finalize = node(
  (_ctx: NodeContext, nodeInput: string) => `final: ${nodeInput}`,
  {name: 'finalize'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [[START, orchestrate, finalize]],
});
