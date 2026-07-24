/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic nodes: an imperative orchestrator drives LlmAgents with `ctx.runNode`
 * in a loop until the generated headline is tech-related. Faithful port of
 * Python `contributing/samples/workflows/dynamic_nodes`.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/dynamic_nodes/agent.ts
 */

import {
  LlmAgent,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';
import {z} from 'zod';

const feedbackSchema = z.object({
  grade: z.enum(['tech-related', 'unrelated']),
  feedback: z.string(),
});

const generateHeadline = node(
  new LlmAgent({
    name: 'generate_headline',
    model: 'gemini-2.5-flash',
    instruction: `
    Write a headline about the topic "{topic}".
    If feedback is provided, take it into account.
    The feedback: {feedback?}
    `,
  }),
);

const evaluateHeadline = node(
  new LlmAgent({
    name: 'evaluate_headline',
    model: 'gemini-2.5-flash',
    instruction:
      'Grade whether the headline is related to technology or software engineering.',
    outputSchema: feedbackSchema,
    outputKey: 'feedback',
  }),
);

const orchestrate = node(
  async function* (ctx: NodeContext, nodeInput: string) {
    ctx.state.set('topic', nodeInput);

    for (;;) {
      const headline = (await ctx.runNode(generateHeadline)).output as string;
      const feedback = (await ctx.runNode(evaluateHeadline, headline))
        .output as {grade: string};
      if (feedback.grade === 'tech-related') {
        yield headline;
        break;
      }
    }
  },
  {name: 'orchestrate', rerunOnResume: true},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'root_agent',
    edges: [['START', orchestrate]],
  }),
);
