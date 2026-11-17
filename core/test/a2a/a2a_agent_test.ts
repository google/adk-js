/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  Message,
  Part,
  Role,
  StreamResponse,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {ClientFactory} from '@a2a-js/sdk/client';
import {
  AgentExecutionEvent,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
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
import {
  A2AEvent,
  createMessage,
  createTextPart,
  isMessage,
  isTask,
  isTaskArtifactUpdateEvent,
  isTaskStatusUpdateEvent,
} from '../../src/a2a/a2a_event.js';

/** An A2A data part. */
function dataPart(value: unknown, metadata: Record<string, unknown>): Part {
  return {
    content: {$case: 'data', value},
    metadata,
    filename: '',
    mediaType: '',
  };
}

/** An A2A text part with no metadata. */
function textPart(text: string): Part {
  return createTextPart(text);
}

/** Wraps an A2A event into the `StreamResponse` a client streams. */
function toStreamResponse(event: A2AEvent): StreamResponse {
  if (isMessage(event)) {
    return {payload: {$case: 'message', value: event}};
  }
  if (isTask(event)) {
    return {payload: {$case: 'task', value: event}};
  }
  if (isTaskArtifactUpdateEvent(event)) {
    return {payload: {$case: 'artifactUpdate', value: event}};
  }
  return {payload: {$case: 'statusUpdate', value: event}};
}

/** A status update with the given state and optional agent message. */
function statusUpdate(
  state: TaskState,
  message?: Message,
  ids = {taskId: 'task-1', contextId: 'ctx-1'},
): TaskStatusUpdateEvent {
  return {
    ...ids,
    status: {state, message, timestamp: undefined},
    metadata: undefined,
  };
}

/** An artifact update with the given text parts. */
function artifactUpdate(
  parts: Part[],
  {
    artifactId = 'art-1',
    append = false,
    lastChunk = false,
  }: {artifactId?: string; append?: boolean; lastChunk?: boolean} = {},
): TaskArtifactUpdateEvent {
  return {
    taskId: 'task-1',
    contextId: 'ctx-1',
    artifact: {
      artifactId,
      name: '',
      description: '',
      parts,
      metadata: undefined,
      extensions: [],
    },
    append,
    lastChunk,
    metadata: undefined,
  };
}

/** An agent message with the given text parts. */
function agentMessage(messageId: string, texts: string[]): Message {
  return createMessage({
    messageId,
    role: Role.ROLE_AGENT,
    parts: texts.map(textPart),
  });
}

vi.mock('@a2a-js/sdk/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2a-js/sdk/client')>();
  const Client = vi.fn().mockImplementation(() => ({
    sendMessageStream: vi.fn(),
    sendMessage: vi.fn(),
  }));
  const ClientFactory = vi.fn().mockImplementation(() => ({
    createFromAgentCard: vi.fn(),
  }));
  return {...actual, Client, ClientFactory};
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
      userMessage: createMessage({
        role: Role.ROLE_USER,
        parts: [createTextPart('hello')],
      }),
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
    // The executor publishes `AgentEvent`s: `{kind, data}`.
    return (mockEventBus.publish as Mock).mock.calls.map(
      (call: unknown[]) => (call[0] as AgentExecutionEvent).data as A2AEvent,
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

    // Every run opens with the task, then the working status update.
    expect(isTask(gotEvents[0])).toBe(true);
    expect((gotEvents[0] as Task).status?.state).toBe(
      TaskState.TASK_STATE_SUBMITTED,
    );
    expect(isTaskStatusUpdateEvent(gotEvents[1])).toBe(true);

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];

    const workingEvent = gotEvents
      .filter(isTaskStatusUpdateEvent)
      .find((e) => e.status?.state === TaskState.TASK_STATE_WORKING);

    expect(workingEvent).toBeDefined();
    expect(workingEvent!.status?.message).toBeUndefined();
    expect(artifacts).toHaveLength(3);
    expect(artifacts[0].artifact!.parts).toEqual([textPart('hello ')]);
    // The first chunk creates the artifact; only later chunks append.
    expect(artifacts[0].append).toBe(false);
    expect(artifacts[0].lastChunk).toBe(false);

    expect(artifacts[1].artifact!.parts).toEqual([textPart('world')]);
    expect(artifacts[1].append).toBe(true);
    expect(artifacts[1].lastChunk).toBe(false);

    expect(artifacts[2].artifact!.parts).toEqual([textPart('hello world')]);
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact!.parts).toEqual([textPart('hello world')]);
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact!.parts).toEqual([
      dataPart(
        {language: Language.PYTHON, code: "print('hello')"},
        {adk_type: 'executable_code'},
      ),
    ]);
    expect(artifacts[1].artifact!.parts).toEqual([
      dataPart(
        {outcome: Outcome.OUTCOME_OK, output: 'hello'},
        {adk_type: 'code_execution_result'},
      ),
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact!.parts).toEqual([
      dataPart(
        {name: 'get_weather', args: {city: 'Warsaw'}},
        {adk_type: 'function_call'},
      ),
    ]);
    expect(artifacts[1].artifact!.parts).toEqual([
      dataPart(
        {name: 'get_weather', response: {temp: '1C'}},
        {adk_type: 'function_response'},
      ),
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact!.parts).toEqual([
      {
        // GenAI inline data is base64; an A2A v1.0 part carries the bytes.
        content: {$case: 'raw', value: Buffer.from('hello', 'base64')},
        metadata: {},
        filename: '',
        mediaType: 'text/plain',
      },
    ]);
    expect(artifacts[1].artifact!.parts).toEqual([
      {
        content: {$case: 'url', value: 'http://text.com/text.txt'},
        metadata: {},
        filename: '',
        mediaType: 'text/plain',
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

    const finalEvent = gotEvents
      .filter(isTaskStatusUpdateEvent)
      .find((e) => e.status?.state === TaskState.TASK_STATE_COMPLETED);

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

    const finalEvent = gotEvents
      .filter(isTaskStatusUpdateEvent)
      .find((e) => e.status?.state === TaskState.TASK_STATE_COMPLETED);

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

    const inputRequiredEvent = gotEvents
      .filter(isTaskStatusUpdateEvent)
      .find((e) => e.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED);

    expect(inputRequiredEvent).toBeDefined();
    expect(inputRequiredEvent!.status?.message?.parts).toEqual([
      dataPart(
        {name: 'create_ticket', id: 'abc-123'},
        {adk_type: 'function_call', adk_is_long_running: true},
      ),
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
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

    const finalEvent = gotEvents
      .filter(isTaskStatusUpdateEvent)
      .find((e) => e.status?.state === TaskState.TASK_STATE_COMPLETED);
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.status?.message).toBeUndefined();
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact!.parts).toEqual([
      textPart('hello'),
      textPart('world'),
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

    const finalEvent = gotEvents
      .filter(isTaskStatusUpdateEvent)
      .find((e) => e.status?.state === TaskState.TASK_STATE_COMPLETED);
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.status?.message).toBeUndefined();
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact!.parts).toEqual([textPart('hello')]);
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact!.parts).toEqual([
      textPart('hello'),
      textPart('world'),
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact!.parts).toEqual([textPart('hello')]);
    expect(artifacts[1].artifact!.parts).toEqual([textPart('world')]);
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
    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];
    expect(artifacts).toHaveLength(0);

    const finalEvent = gotEvents
      .filter(isTaskStatusUpdateEvent)
      .find((e) => e.status?.state === TaskState.TASK_STATE_COMPLETED);
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.status?.message).toBeUndefined();
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

    const artifacts = gotEvents.filter((e: A2AEvent) =>
      isTaskArtifactUpdateEvent(e),
    ) as TaskArtifactUpdateEvent[];

    // According to AgentExecutor, each adkEvent generates an artifact-update:
    // the first partial chunk of an artifact has append=false (it creates the
    // artifact), later partial chunks append=true, all lastChunk=false;
    // partial=false means append=false, lastChunk=true

    expect(artifacts).toHaveLength(5);
    expect(artifacts[0].artifact!.parts).toEqual([textPart('1')]);
    expect(artifacts[0].append).toBe(false);
    expect(artifacts[0].lastChunk).toBe(false);

    expect(artifacts[1].artifact!.parts).toEqual([textPart('2')]);
    expect(artifacts[1].append).toBe(true);
    expect(artifacts[1].lastChunk).toBe(false);

    expect(artifacts[2].artifact!.parts).toEqual([textPart('3')]);
    expect(artifacts[2].append).toBe(false);
    expect(artifacts[2].lastChunk).toBe(true);

    expect(artifacts[3].artifact!.parts).toEqual([textPart('4')]);
    // A new streamed artifact after the final event: its first chunk creates it.
    expect(artifacts[3].append).toBe(false);
    expect(artifacts[3].lastChunk).toBe(false);

    expect(artifacts[4].artifact!.parts).toEqual([textPart('5')]);
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
    events: A2AEvent[],
    beforeCallbacks?: BeforeA2ARequestCallback[],
    afterCallbacks?: AfterA2ARequestCallback[],
  ): Promise<AdkEvent[]> => {
    const card: AgentCard = {
      name: 'Remote',
      description: 'test',
      supportedInterfaces: [
        {
          url: 'https://example.com',
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
          tenant: '',
        },
      ],
      provider: undefined,
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: true, extensions: []},
      securitySchemes: {},
      securityRequirements: [],
      signatures: [],
      skills: [],
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
        yield toStreamResponse(e);
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
    const remoteEvents = [agentMessage('msg-1', [])];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    // In TS, empty parts usually translates to an event with empty parts or undefined content
    expect(gotEvents).toHaveLength(1);
    expect(gotEvents[0].content).toBeUndefined();
  });

  it('message', async () => {
    const remoteEvents = [agentMessage('msg-2', ['hello', 'world'])];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    expect(gotEvents).toHaveLength(1);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'hello', thought: false},
      {text: 'world', thought: false},
    ]);
  });

  it('empty task', async () => {
    const remoteEvents = [statusUpdate(TaskState.TASK_STATE_COMPLETED)];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    // Task status without message is usually transparent or returns final structure
    expect(gotEvents).toBeDefined();
  });

  it('task with status message', async () => {
    const remoteEvents = [
      statusUpdate(
        TaskState.TASK_STATE_COMPLETED,
        agentMessage('msg-inner-1', ['hello']),
      ),
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    expect(gotEvents).toHaveLength(1);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'hello', thought: false},
    ]);
  });

  it('task with multipart artifact', async () => {
    const remoteEvents = [
      artifactUpdate([textPart('hello'), textPart('world')], {
        artifactId: 'art-multipart-1',
      }),
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
      statusUpdate(
        TaskState.TASK_STATE_WORKING,
        agentMessage('msg-working-1', ['hello']),
      ),
      statusUpdate(
        TaskState.TASK_STATE_COMPLETED,
        agentMessage('msg-completed-1', ['world']),
      ),
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
      artifactUpdate([textPart('hello')]),
      statusUpdate(TaskState.TASK_STATE_COMPLETED, undefined, {
        taskId: task.id,
        contextId: task.contextId,
      }),
    ];
    const gotEvents = await runRemoteAgentTest(remoteEvents);
    expect(gotEvents.length).toBeGreaterThan(0);
    expect(gotEvents[0].content?.parts).toEqual([
      {text: 'hello', thought: false},
    ]);
  });

  it('partial and non-partial event aggregation', async () => {
    const remoteEvents = [
      artifactUpdate([textPart('1')], {append: true, lastChunk: false}),
      artifactUpdate([textPart('2')], {append: true, lastChunk: false}),
      artifactUpdate([textPart('3')], {append: false, lastChunk: true}),
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

    expect(gotEvents[2].content?.parts).toEqual([{text: '3', thought: false}]);
    expect(gotEvents[2].partial).toBe(false);
  });

  it('request callbacks modification', async () => {
    const beforeCallback: BeforeA2ARequestCallback = async (ctx, params) => {
      params.configuration = {
        acceptedOutputModes: ['custom'],
        taskPushNotificationConfig: undefined,
        returnImmediately: false,
      };
    };
    const afterCallback: AfterA2ARequestCallback = async (ctx, chunk) => {
      // modify chunk if possible or verify called
      if (isMessage(chunk)) {
        chunk.parts = [textPart('intercepted')];
      }
    };

    const remoteEvents = [agentMessage('msg-3', ['original'])];

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
