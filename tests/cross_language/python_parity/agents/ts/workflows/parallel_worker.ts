/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/parallel_worker.
 *
 * Same chain, same fan-out semantics: a node marked as a parallel worker runs
 * once per item of the list its predecessor produced, and the node after it
 * receives the ordered list of results.
 *
 * Three surface differences:
 *   - Python spells it two ways — `@node(parallel_worker=True)` on a function
 *     and `Agent(parallel_worker=True)` on an agent. adk-js has no
 *     `parallelWorker` field on `LlmAgent`; both cases go through the one
 *     `node(x, {parallelWorker: true})` form, which wraps the built node in a
 *     `ParallelWorker` keeping its name.
 *   - `output_schema=list[str]` has no Zod spelling here: `LlmAgentSchema` is
 *     `ZodObject | genai Schema`, so a non-object output schema must be the
 *     genai `Schema` form.
 *   - adk-js bounds worker concurrency at 8 by default (Python fans out
 *     unbounded). Three topics, so it does not bite here.
 */
import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {Type} from '@google/genai';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const topicExplanationSchema = z.object({
  topic: z.string(),
  explanation: z.string(),
});
type TopicExplanation = z.infer<typeof topicExplanationSchema>;

/** Puts user input in the state. */
const processInput = node(
  (_ctx: NodeContext, nodeInput: string) =>
    createEvent({actions: {stateDelta: {topic: nodeInput}}}),
  {name: 'process_input'},
);

const findRelatedTopics = new LlmAgent({
  name: 'find_related_topics',
  model: PARITY_MODEL,
  instruction:
    'Given the specific topic "{topic}", generate a list of 3 related topics.',
  outputSchema: {type: Type.ARRAY, items: {type: Type.STRING}},
});

const makeUpperCase = node(
  function* (_ctx: NodeContext, nodeInput: string) {
    yield nodeInput.toUpperCase();
  },
  {name: 'make_upper_case', parallelWorker: true},
);

const explainTopic = node(
  new LlmAgent({
    name: 'explain_topic',
    model: PARITY_MODEL,
    instruction:
      'Explain how the following topic relates the the original topic: ' +
      '"{topic}".',
    outputSchema: topicExplanationSchema,
  }),
  {parallelWorker: true},
);

const aggregate = node(
  (_ctx: NodeContext, nodeInput: TopicExplanation[]) =>
    createEvent({
      content: {
        role: 'model',
        parts: [
          {
            text: nodeInput
              .map(
                (explanation) =>
                  `${explanation.topic}: ${explanation.explanation}`,
              )
              .join('\n\n---\n\n'),
          },
        ],
      },
    }),
  {name: 'aggregate'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    [
      'START',
      processInput,
      findRelatedTopics,
      makeUpperCase,
      explainTopic,
      aggregate,
    ],
  ],
});
