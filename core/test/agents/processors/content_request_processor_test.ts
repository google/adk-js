/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  CompactedEvent,
  CONTENT_REQUEST_PROCESSOR,
  createEvent,
  Event,
  EventActions,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
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

  it('should reorder events placing the compacted event first', async () => {
    // A scenario where events 4 and 5 happened before the compact event was written to the session,
    // but the compact event only summarized up to event 3.
    const rawEvents: Event[] = [
      createMockEvent('1', 1000, 'Original message 1'),
      createMockEvent('2', 2000, 'Original message 2'),
      createMockEvent('3', 3000, 'Original message 3'), // This should be covered
      createMockEvent('4', 4000, 'New message 4'),
      createMockEvent('5', 5000, 'New message 5'),
      createCompactedEvent('c1', 6000, 1000, 3000, 'Summary of messages 1-3'),
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

    expect(llmRequest.contents.length).toBe(3);

    // First element in context should be the CompactedEvent, formatted as user context, despite being last in rawEvents
    const compactedContext = llmRequest.contents[0];
    expect(compactedContext.role).toBe('user');
    expect(compactedContext.parts?.[0]?.text).toContain(
      'Summary of messages 1-3',
    );

    // Messages 4 and 5 follow
    expect(llmRequest.contents[1].parts?.[0]?.text).toContain('New message 4');
    expect(llmRequest.contents[2].parts?.[0]?.text).toContain('New message 5');
  });

  it('should only ever produce one compacted event', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 1000, 'Original message 1'),
      createMockEvent('2', 2000, 'Original message 2'),
      createCompactedEvent('c1', 3000, 1000, 2000, 'Summary 1-2'),
      createMockEvent('3', 4000, 'Original message 3'),
      createCompactedEvent('c2', 5000, 1000, 4000, 'Summary 1-3'),
      createMockEvent('4', 6000, 'New message 4'),
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

    // First is the latest compacted event
    expect(llmRequest.contents[0].parts?.[0]?.text).toContain('Summary 1-3');
    // Followed by message 4
    expect(llmRequest.contents[1].parts?.[0]?.text).toContain('New message 4');
  });

  it('should strip adk-* function call IDs for non-Claude models', async () => {
    const events: Event[] = [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'Weather in Paris?'}]},
      }),
      createEvent({
        author: 'test_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                id: 'adk-call-1',
                args: {city: 'Paris'},
              },
            },
          ],
        },
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                id: 'adk-call-1',
                response: {result: 'Sunny'},
              },
            },
          ],
        },
      }),
    ];

    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-flash-latest',
    });
    const session: Session = {
      id: 'test-session',
      events,
      appName: 'test-app',
      userId: 'test-user',
      state: {},
      lastUpdateTime: 0,
    };
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session,
      pluginManager: new PluginManager([]),
    });
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // consume generator
    }

    expect(llmRequest.contents).toHaveLength(3);
    expect(
      llmRequest.contents[1]?.parts?.[0]?.functionCall?.id,
    ).toBeUndefined();
    expect(
      llmRequest.contents[2]?.parts?.[0]?.functionResponse?.id,
    ).toBeUndefined();
  });

  it.each(['default', 'none'] as const)(
    'test_anthropic_model_preserves_function_call_ids (%s)',
    async (includeContents) => {
      const events: Event[] = [
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [{text: 'Weather and time in Paris?'}],
          },
        }),
        createEvent({
          author: 'test_agent',
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'get_weather',
                  id: 'adk-call-1',
                  args: {city: 'Paris'},
                },
              },
              {
                functionCall: {
                  name: 'get_time',
                  id: 'toolu_server_1',
                  args: {city: 'Paris'},
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'test_agent',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'get_weather',
                  id: 'adk-call-1',
                  response: {result: 'Sunny'},
                },
              },
              {
                functionResponse: {
                  name: 'get_time',
                  id: 'toolu_server_1',
                  response: {result: '14:00'},
                },
              },
            ],
          },
        }),
      ];

      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'claude-sonnet-4-6@default',
        includeContents,
      });
      const session: Session = {
        id: 'test-session',
        events,
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        lastUpdateTime: 0,
      };
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent,
        session,
        pluginManager: new PluginManager([]),
      });
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        llmRequest,
      )) {
        // consume generator
      }

      expect(llmRequest.contents).toHaveLength(3);
      expect(llmRequest.contents[1]?.parts?.[0]?.functionCall?.id).toBe(
        'adk-call-1',
      );
      expect(llmRequest.contents[1]?.parts?.[1]?.functionCall?.id).toBe(
        'toolu_server_1',
      );
      expect(llmRequest.contents[2]?.parts?.[0]?.functionResponse?.id).toBe(
        'adk-call-1',
      );
      expect(llmRequest.contents[2]?.parts?.[1]?.functionResponse?.id).toBe(
        'toolu_server_1',
      );
    },
  );

  it('should preserve adk-* function call IDs when agent or ancestor uses a Claude BaseLlm instance', async () => {
    const claudeSymbol = Symbol.for('google.adk.claudeModel');
    class FakeClaudeLlm extends BaseLlm {
      readonly [claudeSymbol] = true;

      constructor() {
        super({model: 'custom-vertex-endpoint'});
      }

      override async *generateContentAsync(): AsyncGenerator<
        LlmResponse,
        void
      > {}

      override async connect(): Promise<BaseLlmConnection> {
        throw new Error('not supported');
      }
    }

    const events: Event[] = [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'Weather in Paris?'}]},
      }),
      createEvent({
        author: 'child_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                id: 'adk-call-2',
                args: {city: 'Paris'},
              },
            },
          ],
        },
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                id: 'adk-call-2',
                response: {result: 'Sunny'},
              },
            },
          ],
        },
      }),
    ];

    const childAgent = new LlmAgent({
      name: 'child_agent',
    });
    new LlmAgent({
      name: 'parent_agent',
      model: new FakeClaudeLlm(),
      subAgents: [childAgent],
    });

    const session: Session = {
      id: 'test-session',
      events,
      appName: 'test-app',
      userId: 'test-user',
      state: {},
      lastUpdateTime: 0,
    };
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: childAgent,
      session,
      pluginManager: new PluginManager([]),
    });
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // consume generator
    }

    expect(llmRequest.contents).toHaveLength(3);
    expect(llmRequest.contents[1]?.parts?.[0]?.functionCall?.id).toBe(
      'adk-call-2',
    );
    expect(llmRequest.contents[2]?.parts?.[0]?.functionResponse?.id).toBe(
      'adk-call-2',
    );
  });
});
