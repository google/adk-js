/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Route: classify the input, then route to the matching branch. Mirrors Python
 * `workflows/route` (classifier kept function-based to run offline; swap for an
 * LlmAgent to classify with a model).
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/route/agent.ts
 * Try inputs like "What is ADK?" (question) or "ADK is great." (statement).
 */

import {
  createEvent,
  DEFAULT_ROUTE,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const classify = node(
  (_c: NodeContext, input: string) => {
    const category = input.trim().endsWith('?') ? 'question' : 'statement';
    return createEvent({route: category, output: input});
  },
  {name: 'classify_input'},
);

const answerQuestion = node(
  (_c: NodeContext, q: string) => `Answer to "${q}": 42.`,
  {name: 'answer_question'},
);
const commentOnStatement = node(
  (_c: NodeContext, s: string) => `Nice statement: "${s}".`,
  {name: 'comment_on_statement'},
);
const handleOther = node(
  () => 'I can only answer questions or comment on statements.',
  {name: 'handle_other'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'route_sample',
    edges: [
      ['START', classify],
      [
        classify,
        {
          question: answerQuestion,
          statement: commentOnStatement,
          [DEFAULT_ROUTE]: handleOther,
        },
      ],
    ],
  }),
);
