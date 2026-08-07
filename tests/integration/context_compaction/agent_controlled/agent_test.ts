/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, isCompactedEvent} from '@google/adk';
import {createUserContent} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GeminiWithMockResponses} from '../../test_case_utils.js';
import {rootAgent} from './agent.js';

describe('Context Compaction Agent-Controlled', () => {
  let currentTime = 1000;

  beforeEach(() => {
    currentTime = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++currentTime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should compact session events when agent calls consolidate_context', async () => {
    rootAgent.model = new GeminiWithMockResponses([
      // Turn 1
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'I am helping you with step 1.'}],
            },
          },
        ],
      },
      // Turn 2: LLM decides to call the tool
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'consolidate_context',
                    args: {detail: 'Completed step 1'},
                  },
                },
              ],
            },
          },
        ],
      },
      // Turn 2 (after tool result is fed back to LLM)
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'I have consolidated the context.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({
      agent: rootAgent,
      appName: 'agent_controlled_compaction_agent',
    });
    const session = await runner.sessionService.createSession({
      appName: 'agent_controlled_compaction_agent',
      userId: 'test_user',
    });

    // Turn 1
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Help me with step 1'),
    })) {
      // intentionally empty
    }

    // Turn 2
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Please consolidate context now'),
    })) {
      // intentionally empty
    }

    // Assert that compaction occurred
    const updatedSession = await runner.sessionService.getSession({
      sessionId: session.id,
      userId: 'test_user',
      appName: 'agent_controlled_compaction_agent',
    });

    const hasCompactedEvent = updatedSession!.events.some(isCompactedEvent);
    expect(hasCompactedEvent).toBe(true);

    const compactedEvent = updatedSession!.events.find(isCompactedEvent);
    expect(compactedEvent).toBeDefined();
    expect(compactedEvent?.compactedContent).toContain(
      'Compacted summary of the conversation.',
    );
  });
});
