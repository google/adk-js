/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Agent,
  Event,
  FunctionTool,
  InMemoryRunner,
  TrajectoryThoughtPruningCompactor,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('TrajectoryThoughtPruning Integration', () => {
  it('should prune thoughts from older turns in a multi-turn conversation', async () => {
    const compactor = new TrajectoryThoughtPruningCompactor({
      eventRetentionSize: 1,
    });

    const agent = new Agent({
      name: 'test-agent',
      instructions: 'You are a helpful assistant.',
      contextCompactors: [compactor],
    });

    const mockResponses = [
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {text: 'Thinking about calling tool...', thought: true},
                {functionCall: {name: 'mock_tool', args: {}}},
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {text: 'Thinking about the final answer...', thought: true},
                {text: 'The weather is nice.'},
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Final answer for turn 2.'}],
            },
          },
        ],
      },
    ];

    agent.model = new GeminiWithMockResponses(mockResponses);

    const tool = new FunctionTool({
      name: 'mock_tool',
      description: 'A mock tool',
      execute: async () => 'Tool response',
    });
    agent.tools = [tool];

    const appName = agent.name;
    const userId = 'test_user';
    const runner = new InMemoryRunner({agent, appName});
    const session = await runner.sessionService.createSession({
      appName,
      userId,
    });

    // --- Turn 1 ---
    const turn1Events: Event[] = [];
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: createUserContent('What is the weather like?'),
    })) {
      if (!event.partial) {
        turn1Events.push(event);
      }
    }

    const sessionAfterTurn1 = await runner.sessionService.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(sessionAfterTurn1).toBeDefined();
    const events1 = sessionAfterTurn1!.events;
    expect(events1.length).toBe(4);

    // Event 1: Model response 1 (should be pruned because compaction ran before step 2)
    const modelEvent1 = events1[1];
    expect(modelEvent1.content?.parts).toEqual([
      expect.objectContaining({
        functionCall: expect.objectContaining({
          name: 'mock_tool',
          args: {},
        }),
      }),
    ]);

    // Event 3: Model response 2 (not pruned yet, it was the tail event when appended)
    const modelEvent2 = events1[3];
    expect(modelEvent2.content?.parts).toEqual([
      {text: 'Thinking about the final answer...', thought: true},
      {text: 'The weather is nice.'},
    ]);

    // --- Turn 2 ---
    for await (const _event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: createUserContent('Thank you.'),
    })) {
      // consume
    }

    const sessionAfterTurn2 = await runner.sessionService.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    const events2 = sessionAfterTurn2!.events;
    expect(events2.length).toBe(6);

    // Event 3: Model response 2 (should be pruned now because it is older than retention size in turn 2)
    const modelEvent2_after = events2[3];
    expect(modelEvent2_after.content?.parts).toEqual([
      {text: 'The weather is nice.'},
    ]);

    // Event 5: Model response 3 (not pruned, no thoughts anyway)
    const modelEvent3 = events2[5];
    expect(modelEvent3.content?.parts).toEqual([
      {text: 'Final answer for turn 2.'},
    ]);
  });
});
