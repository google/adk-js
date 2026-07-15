/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  FunctionNode,
  InMemoryRunner,
  LlmAgent,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {runTestCase} from '../test_case_utils.js';

describe('Workflow Samples: Sequence, Message & State', () => {
  it('should run sequential workflow with LLM agents (sequence sample parity)', async () => {
    const generateFruitAgent = new LlmAgent({
      name: 'generate_fruit_agent',
      instruction:
        'Return the name of a random fruit. Return only the name, nothing else.',
    });

    const generateBenefitAgent = new LlmAgent({
      name: 'generate_benefit_agent',
      instruction: 'Tell me a health benefit about the specified fruit.',
    });

    const rootAgent = new Workflow({
      name: 'root_agent',
      edges: [['START', generateFruitAgent, generateBenefitAgent]],
    });

    await runTestCase({
      agent: rootAgent,
      turns: [
        {
          userPrompt: 'Tell me about a fruit.',
          expectedEvents: [
            createEvent({
              author: 'generate_fruit_agent',
              content: {role: 'model', parts: [{text: 'Apple'}]},
            }),
            createEvent({
              author: 'generate_benefit_agent',
              content: {
                role: 'model',
                parts: [{text: 'Apples are rich in fiber and vitamin C.'}],
              },
            }),
          ],
        },
      ],
      modelResponses: [
        {candidates: [{content: {role: 'model', parts: [{text: 'Apple'}]}}]},
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: 'Apples are rich in fiber and vitamin C.'}],
              },
            },
          ],
        },
      ],
    });
  });

  it('should emit event message from a FunctionNode (message sample parity)', async () => {
    const messageNode = new FunctionNode('emit_message', () =>
      createEvent({
        content: {
          role: 'model',
          parts: [{text: 'Hello from workflow function node!'}],
        },
      }),
    );

    const rootAgent = new Workflow({
      name: 'message_workflow',
      edges: [['START', messageNode]],
    });

    const runner = new InMemoryRunner({agent: rootAgent});
    const events: Event[] = [];

    for await (const event of runner.runEphemeral({
      userId: 'test_user',
      newMessage: {role: 'user', parts: [{text: 'Start'}]},
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const msgEvents = events.filter((e) =>
      e.content?.parts?.some(
        (p) => p.text === 'Hello from workflow function node!',
      ),
    );
    expect(msgEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should read and update session state across FunctionNodes (state sample parity)', async () => {
    const initNode = new FunctionNode('init_state', (ctx, input: string) => {
      ctx.session.state['topic'] = input;
      ctx.session.state['count'] = 1;
      return createEvent({
        actions: {stateDelta: {topic: input, count: 1}},
        content: {
          role: 'model',
          parts: [{text: `Initialized ${input}`}],
        },
      });
    });

    const updateNode = new FunctionNode('update_state', (ctx) => {
      const currentCount = (ctx.session.state['count'] as number) || 0;
      const topic = (ctx.session.state['topic'] as string) || '';
      const newCount = currentCount + 1;
      ctx.session.state['count'] = newCount;
      ctx.session.state['lastProcessed'] = `${topic}_processed`;
      return createEvent({
        actions: {
          stateDelta: {count: newCount, lastProcessed: `${topic}_processed`},
        },
        content: {
          role: 'model',
          parts: [{text: `Processed ${topic} with count ${newCount}`}],
        },
      });
    });

    const rootAgent = new Workflow({
      name: 'state_workflow',
      edges: [['START', initNode, updateNode]],
    });

    const runner = new InMemoryRunner({agent: rootAgent});
    const events: Event[] = [];

    for await (const event of runner.runEphemeral({
      userId: 'test_user',
      newMessage: {role: 'user', parts: [{text: 'AI Workflows'}]},
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(2);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.content?.parts?.[0].text).toContain(
      'Processed AI Workflows with count 2',
    );
  });
});
