/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  CompactedEvent,
  CONTENT_REQUEST_PROCESSOR,
  Event,
  EventActions,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function createMockEvent(id: string, timestamp: number, text: string): Event {
  return {
    id,
    invocationId: 'test-invoc',
    author: 'user',
    actions: {} as EventActions,
    timestamp,
    content: {
      role: 'user',
      parts: [{text}],
    },
  };
}

function createCompactedEvent(
  id: string,
  timestamp: number,
  startTime: number,
  endTime: number,
  compactedContent: string,
): CompactedEvent {
  return {
    id,
    invocationId: 'test-invoc',
    author: 'system',
    actions: {} as EventActions,
    timestamp,
    isCompacted: true,
    startTime,
    endTime,
    compactedContent,
  };
}

function createMockInvocationContext(events: Event[]): InvocationContext {
  const session = {
    id: 'test-session',
    events,
    appName: 'test-app',
    userId: 'test-user',
  } as unknown as Session;

  const agent = new LlmAgent({
    name: 'test_agent',
    model: 'gemini-2.5-flash',
  });

  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: agent as BaseAgent,
    session,
    pluginManager: new PluginManager([]),
  });
}

describe('ContentRequestProcessor', () => {
  it('should format CompactedEvent first and elide covered events', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 1000, 'Original message 1'),
      createMockEvent('2', 2000, 'Original message 2'),
      createMockEvent('3', 3000, 'Original message 3'), // This should be covered
      createCompactedEvent('c1', 3500, 1000, 3000, 'Summary of messages 1-3'),
      createMockEvent('4', 4000, 'New message 4'),
    ];

    const invocationContext = createMockInvocationContext(rawEvents);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.contents.length).toBe(2);

    // First element in context should be the CompactedEvent, formatted as user context
    const compactedContext = llmRequest.contents[0];
    expect(compactedContext.role).toBe('user');
    expect(compactedContext.parts?.[0]?.text).toContain(
      'Summary of messages 1-3',
    );

    // Second element should be message 4 (event 1-3 are elided)
    const newContext = llmRequest.contents[1];
    expect(newContext.role).toBe('user');
    expect(newContext.parts?.[0]?.text).toBe('New message 4');
  });
});
