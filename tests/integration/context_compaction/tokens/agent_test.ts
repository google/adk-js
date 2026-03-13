/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, isCompactedEvent} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../../agents/test_case_utils.js';
import {rootAgent} from './agent.js';

describe('Context Compaction with Tokens', () => {
  it('should act conditionally on tokens and compact session events', async () => {
    // Give the agent mock model responses
    rootAgent.model = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'I am helping you with message 1.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 25,
          totalTokenCount: 35,
        },
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'I am helping you with message 2.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 25,
          totalTokenCount: 35,
        },
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'I am helping you with message 3.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 25,
          totalTokenCount: 35,
        },
      },
    ]);

    const runner = new InMemoryRunner({
      agent: rootAgent,
      appName: 'compaction_agent',
    });
    const session = await runner.sessionService.createSession({
      appName: 'compaction_agent',
      userId: 'test_user',
    });

    // Turn 1
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Message 1'),
    })) {
      // intentionally empty
    }

    // Turn 2
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Message 2'),
    })) {
      // intentionally empty
    }

    // Turn 3 - The threshold (40) is low enough that by turn 3, we should exceed it
    // and compaction should be triggered by the CompactorRequestProcessor.
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Message 3'),
    })) {
      // intentionally empty
    }

    // Assert that compaction occurred
    const updatedSession = await runner.sessionService.getSession({
      sessionId: session.id,
      userId: 'test_user',
      appName: 'compaction_agent',
    });
    const hasCompactedEvent = updatedSession!.events.some(isCompactedEvent);
    // Depending on ADK's core implementation completeness for ContextCompactorRequestProcessor,
    // this might fail, but it demonstrates the agent capability.
    expect(hasCompactedEvent).toBe(true);
  });
});
