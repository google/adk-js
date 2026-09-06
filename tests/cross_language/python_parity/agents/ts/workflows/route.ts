/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/route.
 *
 * A router node emits `route` and a routing-map edge dispatches on it; the two
 * runtimes spell that identically. The only translation is the node bodies:
 * `Event(state=...)` becomes a `ctx.state` write, and Python's parameter
 * binding (`route_on_category(category: InputCategory)`) becomes the explicit
 * `(ctx, input)` handler signature, which receives the same classifier output.
 */
import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

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
  model: PARITY_MODEL,
  instruction:
    'Based on this input, decide which category it belongs to: {input}',
  outputSchema: inputCategorySchema,
  outputKey: 'category',
});

/** Yields an Event with a specific route based on the classification. */
const routeOnCategory = node(
  function* (_ctx: NodeContext, category: InputCategory) {
    yield createEvent({route: category.category});
  },
  {name: 'route_on_category'},
);

const answerQuestion = new LlmAgent({
  name: 'answer_question',
  model: PARITY_MODEL,
  instruction: `Answer the question: {input}`,
});

const commentOnStatement = new LlmAgent({
  name: 'comment_on_statement',
  model: PARITY_MODEL,
  instruction: `Comment on the statement: {input}`,
});

const handleOther = node(
  function* () {
    yield createEvent({
      content: {
        role: 'model',
        parts: [
          {text: 'Sorry I can only answer questions or comment on statements.'},
        ],
      },
    });
  },
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
