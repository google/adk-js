/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/dynamic_nodes/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Dynamic nodes: an imperative `dynamicEntry` drives LlmAgents with
 * `ctx.runNode` in a loop until the generated headline is tech-related, instead
 * of a static edge graph. Faithful port of Python
 * `contributing/samples/workflows/dynamic_nodes`.
 *
 * The loop is bounded (`MAX_ATTEMPTS`) so an off-topic input can't spin forever
 * making live model calls.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/dynamic_nodes/agent.ts
 */

import {LlmAgent, node, NodeContext, Workflow} from '@google/adk';
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

export const rootAgent = new Workflow({
  name: 'root_agent',
  // Imperative entry: drive the child nodes directly via `ctx.runNode()`
  // rather than a static edge graph (mutually exclusive with `edges`).
  dynamicEntry: async (ctx: NodeContext, nodeInput: unknown) => {
    ctx.state.set('topic', nodeInput as string);

    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const headline = (await ctx.runNode(generateHeadline)).output as string;
      const feedback = (await ctx.runNode(evaluateHeadline, headline))
        .output as {grade: string};
      if (feedback.grade === 'tech-related') {
        return headline;
      }
    }
    return `Gave up after ${MAX_ATTEMPTS} attempts (headline never graded tech-related).`;
  },
});
