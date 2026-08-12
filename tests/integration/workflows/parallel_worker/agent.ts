/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/parallel_worker/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Parallel worker: an LlmAgent generates related topics, each is uppercased and
 * explained by a parallel worker (a function and an agent with
 * `parallelWorker: true`), then results are aggregated. Faithful port of Python
 * `contributing/samples/workflows/parallel_worker`.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/parallel_worker/agent.ts
 * Enter a topic, e.g. "databases".
 */

import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {Type} from '@google/genai';
import {z} from 'zod';

interface TopicExplanation {
  topic: string;
  explanation: string;
}

const processInput = node(
  (ctx: NodeContext, nodeInput: string) => {
    ctx.state.set('topic', nodeInput);
  },
  {name: 'process_input'},
);

const findRelatedTopics = new LlmAgent({
  name: 'find_related_topics',
  model: 'gemini-2.5-flash',
  instruction:
    'Given the specific topic "{topic}", generate a list of 3 related topics.',
  outputSchema: {type: Type.ARRAY, items: {type: Type.STRING}},
});

const makeUpperCase = node(
  function* (_c: NodeContext, nodeInput: string) {
    yield nodeInput.toUpperCase();
  },
  {name: 'make_upper_case', parallelWorker: true, maxParallelWorkers: 2},
);

const explainTopic = node(
  new LlmAgent({
    name: 'explain_topic',
    model: 'gemini-2.5-flash',
    instruction:
      'Explain how the following topic relates to the original topic: "{topic}".',
    outputSchema: z.object({topic: z.string(), explanation: z.string()}),
  }),
  // Bound concurrency (at most 2 live model calls at once), demonstrating the
  // `maxParallelWorkers` field the README advertises.
  {parallelWorker: true, maxParallelWorkers: 2},
);

const aggregate = node(
  (_c: NodeContext, nodeInput: TopicExplanation[]) =>
    createEvent({
      content: {
        role: 'model',
        parts: [
          {
            text: nodeInput
              .map((e) => `${e.topic}: ${e.explanation}`)
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
