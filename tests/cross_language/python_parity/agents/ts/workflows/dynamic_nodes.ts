/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/dynamic_nodes.
 *
 * The `loop` sample rewritten as native control flow: one orchestrator node
 * drives `generate_headline` / `evaluate_headline` with `ctx.runNode` inside a
 * `while (true)` until the grade comes back "tech-related". No graph edges are
 * involved beyond `START -> orchestrate`.
 *
 * Surface differences:
 *   - `@node(rerun_on_resume=True)` is `node(fn, {rerunOnResume: true})`.
 *   - `ctx.run_node(...)` resolves to a node *result* here, so the output is
 *     read off `.output`.
 *   - `Feedback.model_validate(...)` is `feedbackSchema.parse(...)`; an agent
 *     with an `outputSchema` already hands back the parsed object in both
 *     runtimes, so this is just the re-validation Python does.
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

const orchestrate = node(
  async function* (ctx: NodeContext, nodeInput: string) {
    yield createEvent({actions: {stateDelta: {topic: nodeInput}}});

    while (true) {
      const headline = await ctx.runNode(generateHeadline);
      const feedback = feedbackSchema.parse(
        (await ctx.runNode(evaluateHeadline, headline.output)).output,
      );
      if (feedback.grade === 'tech-related') {
        yield headline.output;
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
