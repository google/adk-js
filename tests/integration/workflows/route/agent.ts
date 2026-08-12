/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/route/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Route: an LlmAgent classifies the input into a category, a routing node emits
 * that category as the route, and the matching branch (an LlmAgent, or a
 * function for the fallback) handles it. Faithful port of Python
 * `contributing/samples/workflows/route`.
 *
 * REQUIRES an API key (classification and answers call a live model). Set
 * GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/route/agent.ts
 * Try "What is ADK?" (question) or "ADK is great." (statement).
 */

import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

const inputCategorySchema = z.object({
  category: z.enum(['question', 'statement', 'other']),
});
type InputCategory = z.infer<typeof inputCategorySchema>;

const processInput = node(
  (ctx: NodeContext, nodeInput: string) => {
    ctx.state.set('input', nodeInput);
  },
  {name: 'process_input'},
);

const classifyInput = new LlmAgent({
  name: 'classify_input',
  model: 'gemini-2.5-flash',
  instruction:
    'Based on this input, decide which category it belongs to: {input}',
  outputSchema: inputCategorySchema,
  outputKey: 'category',
});

// Yields an Event with a specific route based on the classification.
const routeOnCategory = node(
  (_ctx: NodeContext, category: InputCategory) =>
    createEvent({route: category.category}),
  {name: 'route_on_category'},
);

const answerQuestion = new LlmAgent({
  name: 'answer_question',
  model: 'gemini-2.5-flash',
  instruction: 'Answer the question: {input}',
});

const commentOnStatement = new LlmAgent({
  name: 'comment_on_statement',
  model: 'gemini-2.5-flash',
  instruction: 'Comment on the statement: {input}',
});

const handleOther = node(
  () =>
    createEvent({
      content: {
        role: 'model',
        parts: [
          {text: 'Sorry I can only answer questions or comment on statements.'},
        ],
      },
    }),
  {name: 'handle_other'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    ['START', processInput, classifyInput, routeOnCategory],
    [
      routeOnCategory,
      {
        question: answerQuestion,
        statement: commentOnStatement,
        other: handleOther,
      },
    ],
  ],
});
