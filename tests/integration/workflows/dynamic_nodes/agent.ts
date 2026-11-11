/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic nodes: a single `orchestrate` node drives two LlmAgents imperatively
 * with `ctx.runNode` in a loop until the generated headline is graded
 * tech-related. One-to-one port of Python
 * `contributing/samples/workflows/dynamic_nodes/agent.py`.
 *
 * A node that calls `ctx.runNode` must be declared `rerunOnResume: true`, the
 * same requirement Python's README states for `@node(rerun_on_resume=True)`.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- tests/integration/workflows/dynamic_nodes/agent.ts
 */

import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

const feedbackSchema = z.object({
  grade: z
    .enum(['tech-related', 'unrelated'])
    .describe(
      'Decide if the headline is related to technology or software engineering.',
    ),
  feedback: z
    .string()
    .describe(
      'If the headline is unrelated to technology, provide feedback on how to make it more tech-focused.',
    ),
});

const generateHeadline = new LlmAgent({
  name: 'generate_headline',
  model: 'gemini-2.5-flash',
  instruction: `
    Write a headline about the topic "{topic}".
    If feedback is provided, take it into account.
    The feedback: {feedback?}
    `,
});

const evaluateHeadline = new LlmAgent({
  name: 'evaluate_headline',
  model: 'gemini-2.5-flash',
  instruction: `
    Grade whether the headline is related to technology or software engineering.
    `,
  outputSchema: feedbackSchema,
  outputKey: 'feedback',
});

const orchestrate = node(
  async function* (ctx: NodeContext, nodeInput: string) {
    ctx.state.set('topic', nodeInput);
    yield createEvent({});

    for (;;) {
      const headline = (await ctx.runNode(generateHeadline)).output as string;
      const feedback = feedbackSchema.parse(
        (await ctx.runNode(evaluateHeadline, headline)).output,
      );
      if (feedback.grade === 'tech-related') {
        yield headline;
        break;
      }
    }
  },
  {name: 'orchestrate', rerunOnResume: true},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', orchestrate]],
});
