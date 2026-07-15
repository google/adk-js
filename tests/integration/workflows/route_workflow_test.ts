/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  DEFAULT_ROUTE,
  Event,
  FunctionNode,
  InMemoryRunner,
  LlmAgent,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {runTestCase} from '../test_case_utils.js';

describe('Workflow Samples: Route & Agent in Workflow with DEFAULT_ROUTE', () => {
  it('should route conditionally based on event route (route sample parity)', async () => {
    const classifyInputNode = new FunctionNode(
      'classify_input',
      (_ctx, input: string) => {
        const isQuestion = input.endsWith('?');
        return createEvent({
          route: isQuestion ? 'question' : 'statement',
        });
      },
    );

    const answerQuestionAgent = new LlmAgent({
      name: 'answer_question',
      instruction: 'Answer the user question concisely.',
    });

    const commentOnStatementAgent = new LlmAgent({
      name: 'comment_on_statement',
      instruction: 'Provide a brief comment on the statement.',
    });

    const rootAgent = new Workflow({
      name: 'router_workflow',
      edges: [
        ['START', classifyInputNode],
        [
          classifyInputNode,
          {
            question: answerQuestionAgent,
            statement: commentOnStatementAgent,
          },
        ],
      ],
    });

    // Test question route
    await runTestCase({
      agent: rootAgent,
      turns: [
        {
          userPrompt: 'What is ADK?',
          expectedEvents: [
            createEvent({
              author: 'answer_question',
              content: {
                role: 'model',
                parts: [{text: 'ADK is the Agent Development Kit.'}],
              },
            }),
          ],
        },
      ],
      modelResponses: [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: 'ADK is the Agent Development Kit.'}],
              },
            },
          ],
        },
      ],
    });

    // Test statement route
    await runTestCase({
      agent: rootAgent,
      turns: [
        {
          userPrompt: 'ADK supports workflows and routing.',
          expectedEvents: [
            createEvent({
              author: 'comment_on_statement',
              content: {
                role: 'model',
                parts: [{text: 'That is correct and very powerful!'}],
              },
            }),
          ],
        },
      ],
      modelResponses: [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: 'That is correct and very powerful!'}],
              },
            },
          ],
        },
      ],
    });
  });

  it('should support DEFAULT_ROUTE fallback when specific route does not match (agent_in_workflow sample parity)', async () => {
    const checkIdentityNode = new FunctionNode(
      'check_identity',
      (_ctx, name: string) => {
        if (name.toLowerCase() !== 'jane doe') {
          return createEvent({
            message: `Could not find matching records for ${name}. Let's try again.`,
            route: 'retry',
          });
        }
        return createEvent({
          message: `Hello ${name}! Let me look up your orders.`,
        });
      },
    );

    const retryHandlerNode = new FunctionNode('retry_handler', () =>
      createEvent({message: 'Retrying identity check...'}),
    );

    const generateInstructionAgent = new LlmAgent({
      name: 'generate_instruction',
      instruction: 'Generate preparation instruction for Jane Doe.',
    });

    const rootAgent = new Workflow({
      name: 'agent_in_workflow',
      edges: [
        ['START', checkIdentityNode],
        [
          checkIdentityNode,
          {
            retry: retryHandlerNode,
            [DEFAULT_ROUTE]: generateInstructionAgent,
          },
        ],
      ],
    });

    // Test when route="retry" matches specific route in routing table
    const runnerRetry = new InMemoryRunner({agent: rootAgent});
    const retryEvents: Event[] = [];
    for await (const event of runnerRetry.runEphemeral({
      userId: 'user1',
      newMessage: {role: 'user', parts: [{text: 'John Smith'}]},
    })) {
      retryEvents.push(event);
    }
    expect(
      retryEvents.some(
        (e) => e.content?.parts?.[0].text === 'Retrying identity check...',
      ),
    ).toBe(true);

    // Test when no route is yielded, taking DEFAULT_ROUTE fallback
    await runTestCase({
      agent: rootAgent,
      turns: [
        {
          userPrompt: 'Jane Doe',
          expectedEvents: [
            createEvent({
              author: 'generate_instruction',
              content: {
                role: 'model',
                parts: [
                  {text: 'Please fast for 12 hours before your lipid panel.'},
                ],
              },
            }),
          ],
        },
      ],
      modelResponses: [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {text: 'Please fast for 12 hours before your lipid panel.'},
                ],
              },
            },
          ],
        },
      ],
    });
  });
});
