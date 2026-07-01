/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompactedEvent,
  Event,
  InMemoryRunner,
  isScratchpadEvent,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GeminiWithMockResponses} from '../../test_case_utils.js';
import {rootAgent} from './agent.js';

function getActiveEvents(events: Event[]): Event[] {
  let scratchpad: CompactedEvent | undefined = undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (isScratchpadEvent(events[i])) {
      scratchpad = events[i] as CompactedEvent;
      break;
    }
  }
  if (!scratchpad) return events;
  return [
    scratchpad,
    ...events.filter(
      (e) => !isScratchpadEvent(e) && e.timestamp > scratchpad!.endTime,
    ),
  ];
}

describe('Anchored Context Compaction', () => {
  let mockTime = 1000;
  beforeEach(() => {
    mockTime = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      return mockTime++;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should iteratively merge into a persistent scratchpad at index 0', async () => {
    // 4 turns of agent mock responses.
    // Each turn responds with some content and has promptTokenCount of 25 to trigger compaction.
    rootAgent.model = new GeminiWithMockResponses([
      // Turn 1 response
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Response to Message 1.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 25,
          totalTokenCount: 35,
        },
      },
      // Turn 2 response
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Response to Message 2.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 25,
          totalTokenCount: 35,
        },
      },
      // Turn 3 response
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Response to Message 3.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 25,
          totalTokenCount: 35,
        },
      },
      // Turn 4 response
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Response to Message 4.'}],
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
      appName: 'anchored_compaction_agent',
    });
    const session = await runner.sessionService.createSession({
      appName: 'anchored_compaction_agent',
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

    // Turn 3: Token threshold (40) exceeded (Turn 1 and Turn 2 total tokens > 40).
    // Compaction should run and merge Turn 1 + Turn 2 into Scratchpad 1.
    // Events list should become: [Scratchpad 1, Turn 3 User, Turn 3 Model]
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Message 3'),
    })) {
      // intentionally empty
    }

    // Assert first compaction results
    let updatedSession = await runner.sessionService.getSession({
      sessionId: session.id,
      userId: 'test_user',
      appName: 'anchored_compaction_agent',
    });
    let activeEvents = getActiveEvents(updatedSession!.events);

    expect(activeEvents.length).toBe(4); // Scratchpad + Retained Model 2 + Turn 3 User + Turn 3 Model
    expect(isScratchpadEvent(activeEvents[0])).toBe(true);
    expect(activeEvents[0].author).toBe('system');
    expect((activeEvents[0] as CompactedEvent).compactedContent).toBe(
      'Compacted summary of turn 1 and 2.',
    );
    expect(activeEvents[1].content?.parts?.[0].text).toBe(
      'Response to Message 2.',
    );
    expect(activeEvents[2].content?.parts?.[0].text).toBe('Message 3');
    expect(activeEvents[3].content?.parts?.[0].text).toBe(
      'Response to Message 3.',
    );

    // Turn 4: Token threshold (40) exceeded again (Scratchpad 1 (15) + Turn 3 (25+25) = 65 > 40).
    // Compaction should run and merge Scratchpad 1 + Turn 3 into Scratchpad 2.
    // Events list should become: [Scratchpad 2, Turn 4 User, Turn 4 Model]
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Message 4'),
    })) {
      // intentionally empty
    }

    // Assert second compaction results
    updatedSession = await runner.sessionService.getSession({
      sessionId: session.id,
      userId: 'test_user',
      appName: 'anchored_compaction_agent',
    });
    activeEvents = getActiveEvents(updatedSession!.events);

    expect(activeEvents.length).toBe(4); // Scratchpad 2 + Retained Model 3 + Turn 4 User + Turn 4 Model
    expect(isScratchpadEvent(activeEvents[0])).toBe(true);
    expect(activeEvents[0].author).toBe('system');
    expect((activeEvents[0] as CompactedEvent).compactedContent).toBe(
      'Compacted summary including turn 3 and 4.',
    );
    expect(activeEvents[1].content?.parts?.[0].text).toBe(
      'Response to Message 3.',
    );
    expect(activeEvents[2].content?.parts?.[0].text).toBe('Message 4');
    expect(activeEvents[3].content?.parts?.[0].text).toBe(
      'Response to Message 4.',
    );
  });
});
