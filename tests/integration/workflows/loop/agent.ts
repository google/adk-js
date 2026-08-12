/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/loop/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Loop: generate a headline, grade it, and route back until it is tech-related.
 * Faithful port of Python `contributing/samples/workflows/loop`.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/loop/agent.ts
 * Enter a topic, e.g. "the ocean" (loops until the headline is tech-related).
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

const processInput = node(
  (ctx: NodeContext, nodeInput: string) => {
    ctx.state.set('topic', nodeInput);
  },
  {name: 'process_input'},
);

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

const routeHeadline = node(
  (_c: NodeContext, feedback: {grade: string}) =>
    createEvent({route: feedback.grade}),
  {name: 'route_headline'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    ['START', processInput, generateHeadline, evaluateHeadline, routeHeadline],
    [routeHeadline, {unrelated: generateHeadline}],
  ],
});
