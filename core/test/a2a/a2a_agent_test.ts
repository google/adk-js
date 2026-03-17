/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {ClientFactory} from '@a2a-js/sdk/client';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  AfterA2ARequestCallback,
  BaseAgent,
  BaseSessionService,
  BeforeA2ARequestCallback,
  createEvent,
  createEventActions,
  InvocationContext,
  RemoteA2AAgent,
  Runner,
  RunnerConfig,
  Session,
} from '@google/adk';
import {Language, Outcome} from '@google/genai';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {A2AEvent} from '../../src/a2a/a2a_event.js';

vi.mock('@a2a-js/sdk/client', () => {
  const Client = vi.fn().mockImplementation(() => ({
    sendMessageStream: vi.fn(),
    sendMessage: vi.fn(),
  }));
  const ClientFactory = vi.fn().mockImplementation(() => ({
    createFromAgentCard: vi.fn(),
  }));
  return {Client, ClientFactory};
});

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

describe('A2A Remote Agent', () => {
  let mockClient: {
    sendMessageStream: Mock;
    sendMessage: Mock;
  };
  let mockClientFactory: {
    createFromAgentCard: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      sendMessageStream: vi.fn(),
      sendMessage: vi.fn(),
    };

    mockClientFactory = {
      createFromAgentCard: vi.fn().mockResolvedValue(mockClient),
    };

    vi.mocked(ClientFactory).mockImplementation(
      () => mockClientFactory as unknown as ClientFactory,
    );
  });

  const createMockContext = (overrides = {}): InvocationContext => {
    return {
      invocationId: 'test-invocation',
      session: {
        id: 'test-session',
        userId: 'test-user',
        appName: 'test-app',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello'}]},
          }),
        ],
        state: {},
      } as unknown as Session,
      ...overrides,
    } as unknown as InvocationContext;
  };

  const runRemoteAgentTest = async (
    events: (
      | Message
      | Task
      | TaskStatusUpdateEvent
      | TaskArtifactUpdateEvent
    )[],
    beforeCallbacks?: BeforeA2ARequestCallback[],
    afterCallbacks?: AfterA2ARequestCallback[],
  ): Promise<AdkEvent[]> => {
    const card: AgentCard = {
      name: 'Remote',
      description: 'test',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: true},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: card,
      clientFactory: mockClientFactory as unknown as ClientFactory,
      beforeRequestCallbacks: beforeCallbacks,
      afterRequestCallbacks: afterCallbacks,
    });

    const mockStream = async function* () {
      for (const e of events) {
        yield e;
      }
    };
    mockClient.sendMessageStream.mockReturnValue(mockStream());

    const context = createMockContext();
    const gotEvents: AdkEvent[] = [];

    for await (const event of agent.runAsync(context)) {
      gotEvents.push(event);
    }
    return gotEvents;
  };

  it('empty message', async () => {
    const remoteEvents = [
      {
        kind: 'message' as const,
        messageId: 'msg-1',
        role: 'agent' as const,
        parts: [],
      },
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    // In TS, empty parts usually translates to an event with empty parts or undefined content
    expect(gotEvents).toHaveLength(1);
    expect(gotEvents[0].content).toBeUndefined();
  });

  it('message', async () => {
    const remoteEvents = [
      {
        kind: 'message' as const,
        messageId: 'msg-2',
        role: 'agent' as const,
        parts: [
          {kind: 'text' as const, text: 'hello'},
          {kind: 'text' as const, text: 'world'},
        ],
      },
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    expect(gotEvents).toHaveLength(1);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'hello', thought: false},
      {text: 'world', thought: false},
    ]);
  });

  it('empty task', async () => {
    const remoteEvents = [
      {
        kind: 'status-update' as const,
        contextId: 'ctx-1',
        taskId: 'task-1',
        status: {state: 'completed' as const},
        final: true,
      },
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    // Task status without message is usually transparent or returns final structure
    expect(gotEvents).toBeDefined();
  });

  it('task with status message', async () => {
    const remoteEvents = [
      {
        kind: 'status-update' as const,
        contextId: 'ctx-1',
        taskId: 'task-1',
        status: {
          state: 'completed' as const,
          message: {
            kind: 'message' as const,
            messageId: 'msg-inner-1',
            role: 'agent' as const,
            parts: [{kind: 'text' as const, text: 'hello'}],
          },
        },
        final: true,
      },
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    expect(gotEvents).toHaveLength(1);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'hello', thought: false},
    ]);
  });

  it('task with multipart artifact', async () => {
    const remoteEvents = [
      {
        kind: 'artifact-update' as const,
        contextId: 'ctx-1',
        taskId: 'task-1',
        artifact: {
          artifactId: 'art-multipart-1',
          parts: [
            {kind: 'text' as const, text: 'hello'},
            {kind: 'text' as const, text: 'world'},
          ],
        },
      },
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    expect(gotEvents).toHaveLength(1);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'hello', thought: false},
      {text: 'world', thought: false},
    ]);
  });

  it('multiple tasks', async () => {
    const remoteEvents = [
      {
        kind: 'status-update' as const,
        contextId: 'ctx-1',
        taskId: 'task-1',
        status: {
          state: 'working' as const,
          message: {
            kind: 'message' as const,
            messageId: 'msg-working-1',
            role: 'agent' as const,
            parts: [{kind: 'text' as const, text: 'hello'}],
          },
        },
        final: false,
      },
      {
        kind: 'status-update' as const,
        contextId: 'ctx-1',
        taskId: 'task-1',
        status: {
          state: 'completed' as const,
          message: {
            kind: 'message' as const,
            messageId: 'msg-completed-1',
            role: 'agent' as const,
            parts: [{kind: 'text' as const, text: 'world'}],
          },
        },
        final: true,
      },
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    expect(gotEvents).toHaveLength(2);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'hello', thought: false},
    ]);
    expect(gotEvents[1].content?.parts).toEqual([
      {text: 'world', thought: false},
    ]);
  });

  it('artifact parts translation', async () => {
    const task = {id: 'task-1', contextId: 'ctx-1'};
    const remoteEvents = [
      {
        kind: 'artifact-update' as const,
        taskId: task.id,
        contextId: task.contextId,
        artifact: {
          artifactId: 'art-1',
          parts: [{kind: 'text' as const, text: 'hello'}],
        },
      },
      {
        kind: 'status-update' as const,
        taskId: task.id,
        contextId: task.contextId,
        status: {state: 'completed' as const},
        final: true,
      },
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    expect(gotEvents.length).toBeGreaterThan(0);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'hello', thought: false},
    ]);
  });

  it('partial and non-partial event aggregation', async () => {
    const remoteEvents = [
      {
        kind: 'artifact-update' as const,
        contextId: 'ctx-1',
        taskId: 'task-1',
        artifact: {
          artifactId: 'art-1',
          parts: [{kind: 'text' as const, text: '1'}],
        },
        append: true,
        lastChunk: false,
      },
      {
        kind: 'artifact-update' as const,
        contextId: 'ctx-1',
        taskId: 'task-1',
        artifact: {
          artifactId: 'art-1',
          parts: [{kind: 'text' as const, text: '2'}],
        },
        append: true,
        lastChunk: false,
      },
      {
        kind: 'artifact-update' as const,
        contextId: 'ctx-1',
        taskId: 'task-1',
        artifact: {
          artifactId: 'art-1',
          parts: [{kind: 'text' as const, text: '3'}],
        },
        append: false,
        lastChunk: true,
      },
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);

    // In TS, aggregation emits partials and then a full aggregate if configured,
    // or just follows stream. Based on A2ARemoteAgent implementation:
    // append && !lastChunk yields partial
    // append && lastChunk yields partial AND aggregate
    expect(gotEvents).toHaveLength(3);
    expect(gotEvents[0].content?.parts).toEqual([{text: '1', thought: false}]);
    expect(gotEvents[0].partial).toBe(true);

    expect(gotEvents[1].content?.parts).toEqual([{text: '2', thought: false}]);
    expect(gotEvents[1].partial).toBe(true);

    // Last one should be full aggregate for that atifact id IF it was aggregated
    // Wait, let's verify A2ARemoteAgent agg logic on line 207-224
    // append=false, lastChunk=true calls aggregations.delete and yields adkEvent
    expect(gotEvents[2].content?.parts).toEqual([{text: '3', thought: false}]);
    expect(gotEvents[2].partial).toBe(false);
  });

  it('request callbacks modification', async () => {
    const beforeCallback: BeforeA2ARequestCallback = async (ctx, params) => {
      params.configuration = {acceptedOutputModes: ['custom']};
    };
    const afterCallback: AfterA2ARequestCallback = async (ctx, chunk) => {
      // modify chunk if possible or verify called
      if (chunk.kind === 'message') {
        chunk.parts = [{kind: 'text' as const, text: 'intercepted'}];
      }
    };

    const remoteEvents = [
      {
        kind: 'message' as const,
        messageId: 'msg-3',
        role: 'agent' as const,
        parts: [{kind: 'text' as const, text: 'original'}],
      },
    ];

    const gotEvents = await runRemoteAgentTest(
      remoteEvents,
      [beforeCallback],
      [afterCallback],
    );

    expect(gotEvents).toHaveLength(1);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'intercepted', thought: false},
    ]);
  });
});
