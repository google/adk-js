/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/loop.
 *
 * The back-edge `route_headline --unrelated--> generate_headline` is spelled
 * the same in both runtimes. Two things differ at the node level:
 *   - Python's `Event(state={...})` becomes a `ctx.state` write; the delta is
 *     attached to the node's event either way.
 *   - Python's pydantic `Feedback` becomes a zod object.
 */
import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const feedbackSchema = z.object({
  grade: z
    .enum(['tech-related', 'unrelated'])
    .describe(
      'Decide if the headline is related to technology or software' +
        ' engineering.',
    ),
  feedback: z
    .string()
    .describe(
      'If the headline is unrelated to technology, provide feedback on how' +
        ' to make it more tech-focused.',
    ),
});
type Feedback = z.infer<typeof feedbackSchema>;

/** Puts user input in the state. */
const processInput = node(
  (ctx: NodeContext, nodeInput: string) => {
    ctx.state.set('topic', nodeInput);
  },
  {name: 'process_input'},
);

const generateHeadline = new LlmAgent({
  name: 'generate_headline',
  model: PARITY_MODEL,
  instruction: `
    Write a headline about the topic "{topic}".
    If feedback is provided, take it into account.
    The feedback: {feedback?}
    `,
});

const evaluateHeadline = new LlmAgent({
  name: 'evaluate_headline',
  model: PARITY_MODEL,
  instruction: `
    Grade whether the headline is related to technology or software engineering.
    `,
  outputSchema: feedbackSchema,
  outputKey: 'feedback',
});

const routeHeadline = node(
  (_ctx: NodeContext, nodeInput: Feedback) =>
    createEvent({route: nodeInput.grade}),
  {name: 'route_headline'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    ['START', processInput, generateHeadline, evaluateHeadline, routeHeadline],
    [routeHeadline, {unrelated: generateHeadline}],
  ],
});
