/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Role,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  AgentExecutionEvent,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  BaseSessionService,
  createEvent,
  createEventActions,
  createSession,
  Runner,
  RunnerConfig,
  Session,
} from '@google/adk';
import {beforeEach, describe, expect, it, Mocked, vi} from 'vitest';
import {
  createMessage,
  createTextPart,
  isFinalTaskStatusUpdateEvent,
} from '../../src/a2a/a2a_event.js';

// Mock the Runner to control its async generator
vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: vi.fn(),
      };
    }),
  };
});

// Wire contract, mirroring expected_metadata in the adk-python executor test.
const EXPECTED_SESSION_METADATA = {
  'adk_app_name': 'test-app',
  'adk_user_id': 'test-user',
  'adk_session_id': 'session-id',
};

/** An existing task that waits for the user to answer a function call. */
function inputRequiredTask(): Task {
  return {
    id: 'test-task',
    contextId: 'test-context',
    status: {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      message: createMessage({
        role: Role.ROLE_AGENT,
        parts: [
          {
            content: {
              $case: 'data',
              value: {id: 'fc-123', name: 'mockFunction'},
            },
            metadata: {'adk_type': 'function_call'},
            filename: '',
            mediaType: '',
          },
        ],
      }),
      timestamp: undefined,
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

describe('A2AAgentExecutor', () => {
  let mockSessionService: Mocked<BaseSessionService>;
  let mockEventBus: Mocked<ExecutionEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionService = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      getOrCreateSession: vi.fn(),
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
      appendEvent: vi.fn(),
    } as unknown as Mocked<BaseSessionService>;

    mockEventBus = {
      publish: vi.fn(),
    } as unknown as Mocked<ExecutionEventBus>;
  });

  /** The events published to the event bus, in order. */
  const publishedEvents = (): AgentExecutionEvent[] =>
    mockEventBus.publish.mock.calls.map(
      ([event]) => event as AgentExecutionEvent,
    );

  /** Unwraps the data of an event published to the event bus. */
  const dataOf = <T>(index: number, kind: AgentExecutionEvent['kind']): T => {
    const event = publishedEvents()[index];
    expect(event.kind).toBe(kind);
    return event.data as T;
  };

  const createRequestContext = (overrides = {}): RequestContext => {
    return {
      contextId: 'test-context',
      taskId: 'test-task',
      userMessage: createMessage({
        role: Role.ROLE_USER,
        parts: [createTextPart('hello')],
      }), // a2a UserMessage
      ...overrides,
    } as unknown as RequestContext;
  };

  it('should throw an error if no message is provided', async () => {
    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    const ctx = createRequestContext({userMessage: undefined});
    await expect(executor.execute(ctx, mockEventBus)).rejects.toThrow(
      'message not provided',
    );
  });

  it('should get or create a session, run the agent, and publish working and final status events', async () => {
    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(mockSession);

    const adkEvents: AdkEvent[] = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'response part 1'}]},
        partial: true,
        actions: createEventActions(),
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'response part 2'}]},
        partial: false,
        actions: createEventActions(),
      }),
    ];

    async function* mockRunAsync() {
      for (const e of adkEvents) {
        yield e;
      }
    }

    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    let beforeExecutedCalled = false;
    let afterEventCount = 0;
    let afterExecuteCalled = false;

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
      beforeExecuteCallback: async () => {
        beforeExecutedCalled = true;
      },
      afterEventCallback: async () => {
        afterEventCount++;
      },
      afterExecuteCallback: async () => {
        afterExecuteCalled = true;
      },
    });

    const ctx = createRequestContext();
    await executor.execute(ctx, mockEventBus);

    if (afterEventCount !== 2) {
      console.error(
        'PUBLISHED EVENTS:',
        JSON.stringify(mockEventBus.publish.mock.calls, null, 2),
      );
    }

    expect(beforeExecutedCalled).toBe(true);
    expect(afterEventCount).toBe(2);
    expect(afterExecuteCalled).toBe(true);

    // Verify event bus payload counts
    // Task + Working + 2 task artifact updates + 1 final task status
    expect(mockEventBus.publish).toHaveBeenCalledTimes(5);

    // The run opens with a new task: submitted, with the user message in its history
    const task = dataOf<Task>(0, 'task');
    expect(task.id).toBe('test-task');
    expect(task.contextId).toBe('test-context');
    expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(task.history).toHaveLength(1);
    expect(task.history[0].role).toBe(Role.ROLE_USER);
    expect(task.history[0].parts[0].content).toEqual({
      $case: 'text',
      value: 'hello',
    });

    // Assert that the second published event is the "Working" event
    expect(publishedEvents()[1].kind).toBe('statusUpdate');
    expect(dataOf<TaskStatusUpdateEvent>(1, 'statusUpdate').status?.state).toBe(
      TaskState.TASK_STATE_WORKING,
    );
    expect(publishedEvents()[2].kind).toBe('artifactUpdate');
    expect(publishedEvents()[3].kind).toBe('artifactUpdate');

    // The run ends with a completed status update
    const finalEvent = dataOf<TaskStatusUpdateEvent>(4, 'statusUpdate');
    expect(finalEvent.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it('creates a streamed artifact with its first chunk and appends only later chunks', async () => {
    mockSessionService.getSession.mockResolvedValue({
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session);

    const chunk = (text: string, partial: boolean) =>
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text}]},
        partial,
        actions: createEventActions(),
      });
    const adkEvents = [
      chunk('Hel', true),
      chunk('lo', true),
      chunk('!', true),
      chunk('Hello!', false),
    ];

    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: async function* () {
          yield* adkEvents;
        },
      } as unknown as Runner;
    });

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });
    await executor.execute(createRequestContext(), mockEventBus);

    // Task + Working + 4 artifact updates + final status
    const artifactUpdates = publishedEvents()
      .map((event, index) => ({event, index}))
      .filter(({event}) => event.kind === 'artifactUpdate')
      .map(({index}) =>
        dataOf<TaskArtifactUpdateEvent>(index, 'artifactUpdate'),
      );
    expect(artifactUpdates.map((e) => e.append)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(artifactUpdates.map((e) => e.lastChunk)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(
      new Set(artifactUpdates.map((e) => e.artifact?.artifactId)).size,
    ).toBe(1);
  });

  it('opens a continued task with a snapshot of the existing task, not a new task', async () => {
    mockSessionService.getSession.mockResolvedValue(
      createSession({
        id: 'session-id',
        userId: 'test-user',
        appName: 'test-app',
      }),
    );

    async function* mockRunAsync() {
      yield createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'response'}]},
        partial: false,
        actions: createEventActions(),
      });
    }

    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const executor = new A2AAgentExecutor({
      runner: {appName: 'test-app', sessionService: mockSessionService},
    });

    const existingTask: Task = {
      ...inputRequiredTask(),
      id: 'existing-task',
      contextId: 'existing-context',
      // No pending request, so the run proceeds; a state other than WORKING
      // shows the snapshot's state comes from the executor.
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: undefined,
      },
      history: [
        createMessage({
          role: Role.ROLE_USER,
          parts: [createTextPart('earlier turn')],
        }),
      ],
      artifacts: [
        {
          artifactId: 'earlier-artifact',
          name: '',
          description: '',
          parts: [createTextPart('earlier output')],
          metadata: undefined,
          extensions: [],
        },
      ],
    };
    await executor.execute(
      createRequestContext({task: existingTask}),
      mockEventBus,
    );

    // The snapshot carries the id and context of the existing task, a working
    // state, and no history or artifacts of earlier turns.
    const snapshot = dataOf<Task>(0, 'task');
    expect(snapshot.id).toBe('existing-task');
    expect(snapshot.contextId).toBe('existing-context');
    expect(snapshot.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(snapshot.history).toEqual([]);
    expect(snapshot.artifacts).toEqual([]);
    expect(snapshot.metadata).toEqual(EXPECTED_SESSION_METADATA);

    expect(publishedEvents().map((event) => event.kind)).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    expect(dataOf<TaskStatusUpdateEvent>(1, 'statusUpdate').status?.state).toBe(
      TaskState.TASK_STATE_WORKING,
    );
    expect(dataOf<TaskStatusUpdateEvent>(3, 'statusUpdate').status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
  });

  it('should return early with input required event if task needs input', async () => {
    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(mockSession);

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    const ctx = createRequestContext({task: inputRequiredTask()});

    await executor.execute(ctx, mockEventBus);

    // No runner execution should happen: a snapshot of the existing task, then
    // the input required event
    expect(mockEventBus.publish).toHaveBeenCalledTimes(2);
    const snapshot = dataOf<Task>(0, 'task');
    expect(snapshot.id).toBe('test-task');
    expect(snapshot.contextId).toBe('test-context');
    expect(snapshot.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const event = dataOf<TaskStatusUpdateEvent>(1, 'statusUpdate');
    expect(event.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  });

  it('should publish the task and working events with ADK session metadata', async () => {
    mockSessionService.getSession.mockResolvedValue(
      createSession({
        id: 'session-id',
        userId: 'test-user',
        appName: 'test-app',
      }),
    );

    async function* mockRunAsync() {
      yield createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'response'}]},
        partial: false,
        actions: createEventActions(),
      });
    }

    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const executor = new A2AAgentExecutor({
      runner: {appName: 'test-app', sessionService: mockSessionService},
    });

    await executor.execute(createRequestContext(), mockEventBus);

    const task = dataOf<Task>(0, 'task');
    expect(task.metadata).toEqual(EXPECTED_SESSION_METADATA);

    const workingEvent = dataOf<TaskStatusUpdateEvent>(1, 'statusUpdate');
    expect(workingEvent.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(workingEvent.metadata).toEqual(EXPECTED_SESSION_METADATA);
  });

  it('should publish the input-required event with ADK session metadata', async () => {
    mockSessionService.getSession.mockResolvedValue(
      createSession({
        id: 'session-id',
        userId: 'test-user',
        appName: 'test-app',
      }),
    );

    const executor = new A2AAgentExecutor({
      runner: {appName: 'test-app', sessionService: mockSessionService},
    });

    const ctx = createRequestContext({task: inputRequiredTask()});

    await executor.execute(ctx, mockEventBus);

    expect(mockEventBus.publish).toHaveBeenCalledTimes(2);
    expect(dataOf<Task>(0, 'task').metadata).toEqual(EXPECTED_SESSION_METADATA);
    const event = dataOf<TaskStatusUpdateEvent>(1, 'statusUpdate');
    expect(event.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(event.metadata).toEqual(EXPECTED_SESSION_METADATA);
  });

  it('should handle unrecoverable runner errors properly', async () => {
    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(mockSession);

    async function* mockRunAsyncWithError() {
      yield createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'some part'}]},
        partial: false,
        actions: createEventActions(),
      });
      throw new Error('LLM failed');
    }

    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsyncWithError,
      } as unknown as Runner;
    });

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    const ctx = createRequestContext();
    await executor.execute(ctx, mockEventBus);

    // Task + Working + Artifact update (1) + Failed TaskStatusUpdate (1) = 4 calls
    if (mockEventBus.publish.mock.calls.length < 4) {
      console.error(
        'PUBLISHED EVENTS in error test:',
        JSON.stringify(mockEventBus.publish.mock.calls, null, 2),
      );
    }
    expect(mockEventBus.publish).toHaveBeenCalledTimes(4);

    expect(publishedEvents().map((event) => event.kind)).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    const lastCallArg = dataOf<TaskStatusUpdateEvent>(3, 'statusUpdate');
    expect(lastCallArg.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const content = lastCallArg.status!.message!.parts[0].content;
    expect(content?.$case).toBe('text');
    expect((content as {value: string}).value).toContain('LLM failed');
  });

  it('publishes the task before the failed status when an error happens before the task is published', async () => {
    mockSessionService.getSession.mockResolvedValue(
      createSession({
        id: 'session-id',
        userId: 'test-user',
        appName: 'test-app',
      }),
    );
    const mockRunAsync = vi.fn(async function* () {});
    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const executor = new A2AAgentExecutor({
      runner: {appName: 'test-app', sessionService: mockSessionService},
      beforeExecuteCallback: async () => {
        throw new Error('rejected by callback');
      },
    });

    await executor.execute(createRequestContext(), mockEventBus);

    expect(mockRunAsync).not.toHaveBeenCalled();
    expect(publishedEvents().map((event) => event.kind)).toEqual([
      'task',
      'statusUpdate',
    ]);
    const task = dataOf<Task>(0, 'task');
    expect(task.id).toBe('test-task');
    expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(task.history).toHaveLength(1);
    const failed = dataOf<TaskStatusUpdateEvent>(1, 'statusUpdate');
    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const content = failed.status!.message!.parts[0].content;
    expect((content as {value: string}).value).toContain(
      'rejected by callback',
    );
  });

  it('publishes a snapshot of the existing task before the failed status when a continued task fails early', async () => {
    mockSessionService.getSession.mockResolvedValue(
      createSession({
        id: 'session-id',
        userId: 'test-user',
        appName: 'test-app',
      }),
    );
    const executor = new A2AAgentExecutor({
      runner: {appName: 'test-app', sessionService: mockSessionService},
      beforeExecuteCallback: async () => {
        throw new Error('rejected by callback');
      },
    });

    await executor.execute(
      createRequestContext({task: inputRequiredTask()}),
      mockEventBus,
    );

    const snapshot = dataOf<Task>(0, 'task');
    expect(snapshot.id).toBe('test-task');
    expect(snapshot.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(snapshot.history).toEqual([]);
    expect(snapshot.artifacts).toEqual([]);
    expect(dataOf<TaskStatusUpdateEvent>(1, 'statusUpdate').status?.state).toBe(
      TaskState.TASK_STATE_FAILED,
    );
  });

  it('marks the run as remote-delivered, preserving the configured run config', async () => {
    // A human-in-the-loop gate is not answerable by the peer on the other end
    // of the transport; the run has to know where its message came from.
    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(mockSession);

    const mockRunAsync = vi.fn(async function* () {});
    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
      runConfig: {maxLlmCalls: 7},
    });

    await executor.execute(createRequestContext(), mockEventBus);

    expect(mockRunAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        runConfig: {maxLlmCalls: 7, remoteDelivered: true},
      }),
    );
  });

  it('keys the session by the A2A context id and derives the user from it', async () => {
    mockSessionService.getSession.mockResolvedValue(undefined);
    mockSessionService.createSession.mockResolvedValue(
      createSession({
        id: 'test-context',
        userId: 'A2A_USER_test-context',
        appName: 'test-app',
      }),
    );

    const mockRunAsync = vi.fn(async function* () {
      yield createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'response'}]},
        partial: false,
        actions: createEventActions(),
      });
    });

    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const executor = new A2AAgentExecutor({
      runner: {appName: 'test-app', sessionService: mockSessionService},
    });

    await executor.execute(createRequestContext(), mockEventBus);

    const expectedSessionKey = {
      appName: 'test-app',
      userId: 'A2A_USER_test-context',
      sessionId: 'test-context',
    };
    expect(mockSessionService.getSession).toHaveBeenCalledWith(
      expectedSessionKey,
    );
    expect(mockSessionService.createSession).toHaveBeenCalledWith(
      expectedSessionKey,
    );
    expect(mockRunAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
        newMessage: {role: 'user', parts: [{text: 'hello', thought: false}]},
      }),
    );
  });

  it('should fail cancelTask because it is not implemented', async () => {
    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    await expect(executor.cancelTask('any-task-id')).rejects.toThrow(
      'Task cancellation is not supported yet.',
    );
  });

  describe('runner resolution', () => {
    const runnerConfig = (): RunnerConfig =>
      ({
        appName: 'test-app',
        sessionService: mockSessionService,
      }) as unknown as RunnerConfig;

    beforeEach(() => {
      mockSessionService.getSession.mockResolvedValue(
        createSession({
          id: 'test-context',
          userId: 'A2A_USER_test-context',
          appName: 'test-app',
        }),
      );
      vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: async function* () {},
        } as unknown as Runner;
      });
    });

    const finalStates = (): TaskState[] =>
      publishedEvents()
        .filter(
          (event) =>
            event.kind === 'statusUpdate' &&
            isFinalTaskStatusUpdateEvent(event.data),
        )
        .map((event) => (event.data as TaskStatusUpdateEvent).status!.state);

    it.each([
      {kind: 'a sync', factory: () => vi.fn(runnerConfig)},
      {kind: 'an async', factory: () => vi.fn(async () => runnerConfig())},
    ])(
      'calls $kind runner factory one time across requests',
      async ({factory}) => {
        const runnerFactory = factory();
        const executor = new A2AAgentExecutor({runner: runnerFactory});

        await executor.execute(createRequestContext(), mockEventBus);
        await executor.execute(createRequestContext(), mockEventBus);

        expect(runnerFactory).toHaveBeenCalledTimes(1);
        expect(Runner).toHaveBeenCalledTimes(1);
        expect(finalStates()).toEqual([
          TaskState.TASK_STATE_COMPLETED,
          TaskState.TASK_STATE_COMPLETED,
        ]);
      },
    );

    it('builds one runner from a runner config across requests', async () => {
      const executor = new A2AAgentExecutor({runner: runnerConfig()});

      await executor.execute(createRequestContext(), mockEventBus);
      await executor.execute(createRequestContext(), mockEventBus);

      expect(Runner).toHaveBeenCalledTimes(1);
    });

    it('shares one resolution between concurrent first requests', async () => {
      const runnerFactory = vi.fn(async () => runnerConfig());
      const executor = new A2AAgentExecutor({runner: runnerFactory});

      await Promise.all([
        executor.execute(createRequestContext(), mockEventBus),
        executor.execute(createRequestContext(), mockEventBus),
      ]);

      expect(runnerFactory).toHaveBeenCalledTimes(1);
      expect(Runner).toHaveBeenCalledTimes(1);
    });

    it('resolves the runner again after a failed resolution', async () => {
      const runnerFactory = vi
        .fn<() => Promise<RunnerConfig>>()
        .mockRejectedValueOnce(new Error('The runner is not ready.'))
        .mockResolvedValue(runnerConfig());
      const executor = new A2AAgentExecutor({runner: runnerFactory});

      await expect(
        executor.execute(createRequestContext(), mockEventBus),
      ).rejects.toThrow('The runner is not ready.');
      await executor.execute(createRequestContext(), mockEventBus);

      expect(runnerFactory).toHaveBeenCalledTimes(2);
      expect(finalStates()).toEqual([TaskState.TASK_STATE_COMPLETED]);
    });
  });

  it('publishes an auth-required final status when the run ends on a credential request', async () => {
    mockSessionService.getSession.mockResolvedValue(
      createSession({
        id: 'test-context',
        userId: 'A2A_USER_test-context',
        appName: 'test-app',
      }),
    );
    vi.mocked(Runner).mockImplementation(function (config: RunnerConfig) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: async function* () {
          yield createEvent({
            author: 'model',
            longRunningToolIds: ['credential-call'],
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'credential-call',
                    name: 'adk_request_credential',
                    args: {},
                  },
                },
              ],
            },
            actions: createEventActions(),
          });
        },
      } as unknown as Runner;
    });
    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    await executor.execute(createRequestContext(), mockEventBus);

    expect(publishedEvents()[0].kind).toBe('task');
    const lastEvent = publishedEvents().at(-1)!;
    expect(lastEvent.kind).toBe('statusUpdate');
    const finalStatus = lastEvent.data as TaskStatusUpdateEvent;
    expect(finalStatus.status?.state).toBe(TaskState.TASK_STATE_AUTH_REQUIRED);
    expect(isFinalTaskStatusUpdateEvent(finalStatus)).toBe(true);
  });
});
