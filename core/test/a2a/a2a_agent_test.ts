/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskArtifactUpdateEvent, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  BaseAgent,
  BaseSessionService,
  createEvent,
  createEventActions,
  InvocationContext,
  Runner,
  RunnerConfig,
  Session,
} from '@google/adk';
import {Language, Outcome} from '@google/genai';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {A2AEvent} from '../../src/a2a/a2a_event.js';

class MockAgent extends BaseAgent {
  protected runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Method not implemented.');
  }
  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Method not implemented.');
  }
}

class MockRunner extends Runner {
  private readonly events: AdkEvent[];

  constructor(config: RunnerConfig, events: AdkEvent[]) {
    super(config);
    this.events = events;
  }

  async *runAsync() {
    for (const e of this.events) {
      yield e;
    }
  }
}

describe('A2A Agent Executor', () => {
  let mockSessionService: BaseSessionService;
  let mockEventBus: ExecutionEventBus;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionService = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      getOrCreateSession: vi.fn(),
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
      appendEvent: vi.fn(),
    } as unknown as BaseSessionService;

    mockEventBus = {
      publish: vi.fn(),
    } as unknown as ExecutionEventBus;

    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    (mockSessionService.getSession as Mock).mockResolvedValue(mockSession);
  });

  const createRequestContext = (overrides = {}): RequestContext => {
    return {
      contextId: 'test-context',
      taskId: 'test-task',
      userMessage: {role: 'user', parts: [{kind: 'text', text: 'hello'}]},
      ...overrides,
    } as unknown as RequestContext;
  };

  const runTest = async (remoteEvents: AdkEvent[]): Promise<A2AEvent[]> => {
    const executor = new A2AAgentExecutor({
      // @ts-expect-error: MockRunner correctly implements Runner interface.
      runner: new MockRunner(
        {
          appName: 'test-app',
          agent: new MockAgent({name: 'test-agent'}),
          sessionService: mockSessionService,
        },
        remoteEvents,
      ),
    });

    const ctx = createRequestContext();
    await executor.execute(ctx, mockEventBus);
    return (mockEventBus.publish as Mock).mock.calls.map(
      (call: unknown[]) => call[0] as A2AEvent,
    );
  };

  it('text streaming', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'hello '}]},
        partial: true,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'world'}]},
        partial: true,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'hello world'}]},
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];

    const workingEvent = gotEvents.find(
      (e: A2AEvent) =>
        e.kind === 'status-update' && e.status?.state === 'working',
    ) as TaskStatusUpdateEvent | undefined;

    expect(workingEvent).toBeDefined();
    expect(workingEvent!.status.message).toBeUndefined();
    expect(artifacts).toHaveLength(3);
    expect(artifacts[0].artifact.parts).toEqual([
      {kind: 'text', text: 'hello '},
    ]);
    expect(artifacts[0].append).toBe(true);
    expect(artifacts[0].lastChunk).toBe(false);

    expect(artifacts[1].artifact.parts).toEqual([
      {kind: 'text', text: 'world'},
    ]);
    expect(artifacts[1].append).toBe(true);
    expect(artifacts[1].lastChunk).toBe(false);

    expect(artifacts[2].artifact.parts).toEqual([
      {kind: 'text', text: 'hello world'},
    ]);
    expect(artifacts[2].append).toBe(false);
    expect(artifacts[2].lastChunk).toBe(true);
  });

  it('text streaming - no streaming mode', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'hello world'}]},
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.parts).toEqual([
      {kind: 'text', text: 'hello world'},
    ]);
    expect(artifacts[0].append).toBe(false);
    expect(artifacts[0].lastChunk).toBe(true);
  });

  it('code execution', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {
              executableCode: {
                language: Language.PYTHON,
                code: "print('hello')",
              },
            },
          ],
        },
        partial: false,
      }),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {
              codeExecutionResult: {
                outcome: Outcome.OUTCOME_OK,
                output: 'hello',
              },
            },
          ],
        },
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact.parts).toEqual([
      {
        kind: 'data',
        data: {language: Language.PYTHON, code: "print('hello')"},
        metadata: {adk_type: 'executable_code'},
      },
    ]);
    expect(artifacts[1].artifact.parts).toEqual([
      {
        kind: 'data',
        data: {outcome: Outcome.OUTCOME_OK, output: 'hello'},
        metadata: {adk_type: 'code_execution_result'},
      },
    ]);
  });

  it('function calls', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'get_weather', args: {city: 'Warsaw'}}},
          ],
        },
        partial: false,
      }),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {functionResponse: {name: 'get_weather', response: {temp: '1C'}}},
          ],
        },
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact.parts).toEqual([
      {
        kind: 'data',
        data: {name: 'get_weather', args: {city: 'Warsaw'}},
        metadata: {adk_type: 'function_call'},
      },
    ]);
    expect(artifacts[1].artifact.parts).toEqual([
      {
        kind: 'data',
        data: {name: 'get_weather', response: {temp: '1C'}},
        metadata: {adk_type: 'function_response'},
      },
    ]);
  });

  it('files', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{inlineData: {data: 'hello', mimeType: 'text/plain'}}],
        },
        partial: false,
      }),
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {
              fileData: {
                fileUri: 'http://text.com/text.txt',
                mimeType: 'text/plain',
              },
            },
          ],
        },
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact.parts).toEqual([
      {
        kind: 'file',
        file: {bytes: 'hello', mimeType: 'text/plain'},
        metadata: {},
      },
    ]);
    expect(artifacts[1].artifact.parts).toEqual([
      {
        kind: 'file',
        file: {uri: 'http://text.com/text.txt', mimeType: 'text/plain'},
        metadata: {},
      },
    ]);
  });

  it('escalation', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'stop'}]},
        partial: false,
        actions: createEventActions({escalate: true}),
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const finalEvent = gotEvents.find(
      (e: A2AEvent) =>
        e.kind === 'status-update' && e.status?.state === 'completed',
    ) as TaskStatusUpdateEvent | undefined;

    expect(finalEvent).toBeDefined();
    expect(finalEvent!.metadata?.adk_escalate).toBe(true);
  });

  it('transfer', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'stop'}]},
        partial: false,
        actions: createEventActions({transferToAgent: 'a-2'}),
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const finalEvent = gotEvents.find(
      (e: A2AEvent) =>
        e.kind === 'status-update' && e.status?.state === 'completed',
    ) as TaskStatusUpdateEvent | undefined;

    expect(finalEvent).toBeDefined();
    expect(finalEvent!.metadata?.adk_transfer_to_agent).toBe('a-2');
  });

  it('long-running function call', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'create_ticket', id: 'abc-123'}}],
        },
        partial: false,
        longRunningToolIds: ['abc-123'],
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const inputRequiredEvent = gotEvents.find(
      (e: A2AEvent) =>
        e.kind === 'status-update' && e.status?.state === 'input-required',
    ) as TaskStatusUpdateEvent | undefined;

    expect(inputRequiredEvent).toBeDefined();
    expect(inputRequiredEvent!.status.message?.parts).toEqual([
      {
        kind: 'data',
        data: {name: 'create_ticket', id: 'abc-123'},
        metadata: {adk_type: 'function_call', adk_is_long_running: true},
      },
    ]);
  });

  it('metadata', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'hello'}]},
        partial: false,
        citationMetadata: {citations: [{title: 'Title1'}, {title: 'Title2'}]},
        usageMetadata: {
          candidatesTokenCount: 12,
          promptTokenCount: 42,
          totalTokenCount: 54,
        },
        groundingMetadata: {searchEntryPoint: {renderedContent: 'id1'}},
        customMetadata: {nested: {key: 'value'}},
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].metadata?.adk_citation_metadata).toEqual({
      citations: [{title: 'Title1'}, {title: 'Title2'}],
    });
    expect(artifacts[0].metadata?.adk_usage_metadata).toEqual({
      candidatesTokenCount: 12,
      promptTokenCount: 42,
      totalTokenCount: 54,
    });
    expect(artifacts[0].metadata?.adk_grounding_metadata).toEqual({
      searchEntryPoint: {renderedContent: 'id1'},
    });
    expect(artifacts[0].metadata?.adk_custom_metadata).toEqual({
      nested: {key: 'value'},
    });
  });

  it('handles empty message', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: []},
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const finalEvent = gotEvents.find(
      (e: A2AEvent) =>
        e.kind === 'status-update' && e.status?.state === 'completed',
    ) as TaskStatusUpdateEvent | undefined;
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.status.message).toBeUndefined();
  });

  it('handles message with text parts', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{text: 'hello'}, {text: 'world'}],
        },
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.parts).toEqual([
      {kind: 'text', text: 'hello'},
      {kind: 'text', text: 'world'},
    ]);
  });

  it('handles empty task', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: []},
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const finalEvent = gotEvents.find(
      (e: A2AEvent) =>
        e.kind === 'status-update' && e.status?.state === 'completed',
    ) as TaskStatusUpdateEvent | undefined;
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.status.message).toBeUndefined();
  });

  it('handles task with status message', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'hello'}]},
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.parts).toEqual([
      {kind: 'text', text: 'hello'},
    ]);
  });

  it('handles task with multipart artifact', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [{text: 'hello'}, {text: 'world'}],
        },
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.parts).toEqual([
      {kind: 'text', text: 'hello'},
      {kind: 'text', text: 'world'},
    ]);
  });

  it('handles multiple tasks', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'hello'}]},
        partial: false,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'world'}]},
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact.parts).toEqual([
      {kind: 'text', text: 'hello'},
    ]);
    expect(artifacts[1].artifact.parts).toEqual([
      {kind: 'text', text: 'world'},
    ]);
  });

  it('handles empty non-final status updates ignored', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: []},
        partial: true,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: []},
        partial: true,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: []},
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(0);

    const finalEvent = gotEvents.find(
      (e: A2AEvent) =>
        e.kind === 'status-update' && e.status?.state === 'completed',
    ) as TaskStatusUpdateEvent | undefined;
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.status.message).toBeUndefined();
  });

  it('handles partial and non-partial event aggregation', async () => {
    const remoteEvents = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: '1'}]},
        partial: true,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: '2'}]},
        partial: true,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: '3'}]},
        partial: false,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: '4'}]},
        partial: true,
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: '5'}]},
        partial: false,
      }),
    ];

    const gotEvents = await runTest(remoteEvents);

    const artifacts = gotEvents.filter(
      (e: A2AEvent) => e.kind === 'artifact-update',
    ) as TaskArtifactUpdateEvent[];

    // According to AgentExecutor, each adkEvent generates an artifact-update
    // partial=true means append=true, lastChunk=false
    // partial=false means append=false, lastChunk=true

    expect(artifacts).toHaveLength(5);
    expect(artifacts[0].artifact.parts).toEqual([{kind: 'text', text: '1'}]);
    expect(artifacts[0].append).toBe(true);
    expect(artifacts[0].lastChunk).toBe(false);

    expect(artifacts[1].artifact.parts).toEqual([{kind: 'text', text: '2'}]);
    expect(artifacts[1].append).toBe(true);
    expect(artifacts[1].lastChunk).toBe(false);

    expect(artifacts[2].artifact.parts).toEqual([{kind: 'text', text: '3'}]);
    expect(artifacts[2].append).toBe(false);
    expect(artifacts[2].lastChunk).toBe(true);

    expect(artifacts[3].artifact.parts).toEqual([{kind: 'text', text: '4'}]);
    expect(artifacts[3].append).toBe(true);
    expect(artifacts[3].lastChunk).toBe(false);

    expect(artifacts[4].artifact.parts).toEqual([{kind: 'text', text: '5'}]);
    expect(artifacts[4].append).toBe(false);
    expect(artifacts[4].lastChunk).toBe(true);
  });
});
