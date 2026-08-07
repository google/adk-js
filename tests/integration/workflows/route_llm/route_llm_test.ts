/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test mirroring the Python `workflows/route` sample: an LLM
 * classifier with an output schema drives conditional routing to branch agents.
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RawGenerateContentResponse} from '../../test_case_utils.js';
import {
  finalOutput,
  mockLlmAgent,
  runWorkflowOnce,
} from '../_harness/workflow_test_utils.js';
import modelResponses from './route.model_responses.json' with {type: 'json'};

const responses = modelResponses as Record<
  string,
  RawGenerateContentResponse[]
>;

describe('workflow integration — route via LLM classifier', () => {
  it('classifies the input and routes to the matching branch agent', async () => {
    const processInput = node(
      (ctx: NodeContext, input: string) => {
        ctx.state.set('input', input);
        return input;
      },
      {name: 'process_input'},
    );

    const classifyInput = mockLlmAgent(
      {
        name: 'classify_input',
        instruction:
          'Based on this input, decide which category it belongs to: {input}',
        outputSchema: z.object({
          category: z.enum(['question', 'statement', 'other']),
        }),
        outputKey: 'category',
      },
      responses['classify_input'],
    );

    const routeOnCategory = node(
      (_c: NodeContext, input: unknown) => {
        const category =
          typeof input === 'string'
            ? (JSON.parse(input) as {category: string}).category
            : (input as {category: string}).category;
        return createEvent({route: category});
      },
      {name: 'route_on_category'},
    );

    const answerQuestion = mockLlmAgent(
      {name: 'answer_question', instruction: 'Answer the question: {input}'},
      responses['answer_question'],
    );
    const commentOnStatement = mockLlmAgent(
      {
        name: 'comment_on_statement',
        instruction: 'Comment on the statement: {input}',
      },
      [],
    );
    const handleOther = node(
      () =>
        createEvent({
          content: {
            role: 'model',
            parts: [{text: 'I can only answer questions or comment.'}],
          },
        }),
      {name: 'handle_other'},
    );

    const wf = new Workflow({
      name: 'route_llm',
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

    const events = await runWorkflowOnce(wf, 'What is the meaning of life?');

    // Classified as "question" -> routed to answer_question.
    expect(finalOutput(events)).toBe('The answer is 42.');
    expect(events.some((e) => e.author === 'answer_question')).toBe(true);
    expect(events.some((e) => e.author === 'comment_on_statement')).toBe(false);
  });
});
