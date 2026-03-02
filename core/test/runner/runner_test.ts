/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  createEvent,
  createEventActions,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
} from '@google/adk';
import {Content, FunctionCall, FunctionResponse} from '@google/genai';

const TEST_APP_ID = 'test_app_id';
const TEST_USER_ID = 'test_user_id';
const TEST_SESSION_ID = 'test_session_id';
const TEST_MESSAGE = 'test_message';

class MockLlmAgent extends LlmAgent {
  constructor(
    name: string,
    disallowTransferToParent = false,
    parentAgent?: BaseAgent,
  ) {
    super({
      name,
      model: 'gemini-2.5-flash',
      subAgents: [],
      parentAgent,
      disallowTransferToParent,
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Test LLM response'}]},
    });
  }
}

class StreamedFunctionResponseAgent extends LlmAgent {
  constructor(name: string) {
    super({
      name,
      model: 'gemini-2.5-flash',
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const responses: FunctionResponse[] = [
      {id: 'fc-a', name: 'toolA', response: {result: 'A'}},
      {id: 'fc-b', name: 'toolB', response: {result: 'B'}},
      {id: 'fc-c', name: 'toolC', response: {result: 'C'}},
    ];

    for (const functionResponse of responses) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {role: 'user', parts: [{functionResponse}]},
      });
    }
  }
}

class MockPlugin extends BasePlugin {
  static ON_USER_CALLBACK_MSG =
    'Modified user message ON_USER_CALLBACK_MSG from MockPlugin';
  static ON_EVENT_CALLBACK_MSG =
    'Modified event ON_EVENT_CALLBACK_MSG from MockPlugin';
  static BEFORE_RUN_CALLBACK_MSG =
    'Before run callback message from MockPlugin';

  enableUserMessageCallback = false;
  enableEventCallback = false;
  enableBeforeRunCallback = false;
  afterRunCallbackCalled = false;
  onEventCallbackInvocationCount = 0;
  onEventFunctionResponseCount = 0;

  constructor() {
    super('mock_plugin');
  }

  override async onUserMessageCallback(_params: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    if (!this.enableUserMessageCallback) {
      return undefined;
    }
    return {
      role: 'model',
      parts: [{text: MockPlugin.ON_USER_CALLBACK_MSG}],
    };
  }

  override async onEventCallback({
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    this.onEventCallbackInvocationCount++;
    if (event.content?.parts?.some((part) => part.functionResponse)) {
      this.onEventFunctionResponseCount++;
    }
    if (!this.enableEventCallback) {
      return undefined;
    }
    return createEvent({
      invocationId: '',
      author: '',
      content: {
        parts: [
          {
            text: MockPlugin.ON_EVENT_CALLBACK_MSG,
          },
        ],
        role: event.content!.role,
      },
    });
  }

  override async beforeRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    if (!this.enableBeforeRunCallback) {
      return undefined;
    }
    return {
      role: 'model',
      parts: [{text: MockPlugin.BEFORE_RUN_CALLBACK_MSG}],
    };
  }

  override async afterRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    this.afterRunCallbackCalled = true;
    return Promise.resolve();
  }
}

describe('Runner.determineAgentForResumption', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let rootAgent: MockLlmAgent;
  let subAgent1: MockLlmAgent;
  let subAgent2: MockLlmAgent;
  let nonTransferableAgent: MockLlmAgent;
  let runner: Runner;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    rootAgent = new MockLlmAgent('root_agent');
    subAgent1 = new MockLlmAgent('sub_agent1', false, rootAgent);
    subAgent2 = new MockLlmAgent('sub_agent2', false, rootAgent);
    nonTransferableAgent = new MockLlmAgent(
      'non_transferable',
      true,
      rootAgent,
    );
    rootAgent.subAgents.push(subAgent1, subAgent2, nonTransferableAgent);

    runner = new Runner({
      appName: TEST_APP_ID,
      agent: rootAgent,
      sessionService,
      artifactService,
    });
  });

  /**
   * Run a single test with a given set of events. Creates a session and appends
   * all events followed by a simple user message to synchronously run the
   * model.
   */
  async function runTest(inputEvents: Event[]) {
    // This runTest works for most scenarios but not all. It may need to be
    // refactored in the future for more flexibility.
    if (inputEvents.length === 0) {
      throw new Error('No input events provided');
    }

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    for (const event of inputEvents) {
      await sessionService.appendEvent({session: session, event: event});
    }

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
    })) {
      events.push(event);
    }

    return events;
  }

  it('should find agent when last event is function response', async () => {
    const functionCall: FunctionCall = {
      id: 'func_123',
      name: 'test_func',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_123',
      name: 'test_func',
      response: {},
    };

    const callEvent = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{functionCall}]},
    });

    const responseEvent = createEvent({
      invocationId: 'inv2',
      author: 'user',
      content: {role: 'user', parts: [{functionResponse}]},
    });

    const events = await runTest([callEvent, responseEvent]);

    expect(events[0].author).toBe('sub_agent1');
  });

  it('should resolve author from partial responses when completion sentinel exists', async () => {
    const partialCallEvent = createEvent({
      invocationId: 'inv-parallel-call',
      author: 'sub_agent2',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'func_1',
              name: 'tool_1',
              args: {},
            },
          },
          {
            functionCall: {
              id: 'func_2',
              name: 'tool_2',
              args: {},
            },
          },
          {
            functionCall: {
              id: 'func_3',
              name: 'tool_3',
              args: {},
            },
          },
        ],
      },
    });

    const partialResponseEvent = createEvent({
      invocationId: 'inv-partial-response',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'func_1',
              name: 'tool_1',
              response: {result: 'partial'},
            },
          },
        ],
      },
    });

    const completionSentinelEvent = createEvent({
      invocationId: 'inv-completion-sentinel',
      author: 'sub_agent2',
      actions: createEventActions({
        customMetadata: {
          parallelToolBatchCompletion: {
            functionCallEventId: partialCallEvent.id,
            expectedResponseCount: 3,
          },
        },
      }),
    });

    const events = await runTest([
      partialCallEvent,
      partialResponseEvent,
      completionSentinelEvent,
    ]);
    expect(events[0].author).toBe('sub_agent2');
  });

  it('should not resume from partial parallel responses without a completion sentinel', async () => {
    const partialCallEvent = createEvent({
      invocationId: 'inv-parallel-call',
      author: 'sub_agent2',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'func_1',
              name: 'tool_1',
              args: {},
            },
          },
          {
            functionCall: {
              id: 'func_2',
              name: 'tool_2',
              args: {},
            },
          },
          {
            functionCall: {
              id: 'func_3',
              name: 'tool_3',
              args: {},
            },
          },
        ],
      },
    });

    const partialResponseEvent = createEvent({
      invocationId: 'inv-partial-response',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'func_1',
              name: 'tool_1',
              response: {result: 'partial'},
            },
          },
        ],
      },
    });

    // Desired behavior after sentinel support:
    // without a completion sentinel for the parallel batch, resumption should
    // not continue from partial responses.
    const events = await runTest([partialCallEvent, partialResponseEvent]);
    expect(events[0].author).toBe('root_agent');
  });

  it('should resume to originating agent when all parallel responses are present but no sentinel', async () => {
    const partialCallEvent = createEvent({
      invocationId: 'inv-parallel-call',
      author: 'sub_agent2',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'func_1', name: 'tool_1', args: {}}},
          {functionCall: {id: 'func_2', name: 'tool_2', args: {}}},
          {functionCall: {id: 'func_3', name: 'tool_3', args: {}}},
        ],
      },
    });

    const responseEvent1 = createEvent({
      invocationId: 'inv-response-1',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'func_1',
              name: 'tool_1',
              response: {result: 'r1'},
            },
          },
        ],
      },
    });

    const responseEvent2 = createEvent({
      invocationId: 'inv-response-2',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'func_2',
              name: 'tool_2',
              response: {result: 'r2'},
            },
          },
        ],
      },
    });

    const responseEvent3 = createEvent({
      invocationId: 'inv-response-3',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'func_3',
              name: 'tool_3',
              response: {result: 'r3'},
            },
          },
        ],
      },
    });

    // All 3 responses present with no sentinel — batch is complete, should route to originating agent
    const events = await runTest([
      partialCallEvent,
      responseEvent1,
      responseEvent2,
      responseEvent3,
    ]);
    expect(events[0].author).toBe('sub_agent2');
  });

  it('should return root agent when session has no non-user events', async () => {
    const nonUserEvent = createEvent({
      invocationId: 'inv1',
      author: 'user',
      content: {role: 'user', parts: [{text: 'Hello'}]},
    });

    const events = await runTest([nonUserEvent]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should return root agent when it is found in session events', async () => {
    const rootEvent = createEvent({
      invocationId: 'inv1',
      author: 'root_agent',
      content: {role: 'model', parts: [{text: 'Root response'}]},
    });

    const events = await runTest([rootEvent]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should return transferable sub agent when found', async () => {
    const subAgent1Event = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'Sub agent response'}]},
    });

    const events = await runTest([subAgent1Event]);

    expect(events[0].author).toBe('sub_agent1');
  });

  it('should skip non-transferable agent and return root agent', async () => {
    const nonTransferableResponse = createEvent({
      invocationId: 'inv1',
      author: 'non_transferable',
      content: {
        role: 'model',
        parts: [{text: 'Non-transferable response'}],
      },
    });

    const events = await runTest([nonTransferableResponse]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should skip unknown agent and return root agent', async () => {
    const unknownEvent = createEvent({
      invocationId: 'inv1',
      author: 'unknown_agent',
      content: {
        role: 'model',
        parts: [{text: 'Unknown agent response'}],
      },
    });

    const rootAgentEvent = createEvent({
      invocationId: 'inv2',
      author: 'root_agent',
      content: {role: 'model', parts: [{text: 'Root response'}]},
    });

    const events = await runTest([unknownEvent, rootAgentEvent]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should prioritize function response scenario', async () => {
    const functionCall: FunctionCall = {
      id: 'func_456',
      name: 'test_func',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_456',
      name: 'test_func',
      response: {},
    };

    const callEvent = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent2',
      content: {role: 'model', parts: [{functionCall}]},
    });

    const rootEvent = createEvent({
      invocationId: 'inv2',
      author: 'root_agent',
      content: {role: 'model', parts: [{text: 'Root response'}]},
    });

    // Bypass the runTest method for finer control over events.
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    await sessionService.appendEvent({session: session, event: callEvent});
    await sessionService.appendEvent({session: session, event: rootEvent});

    const events: Event[] = [];

    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{functionResponse}]},
    })) {
      events.push(event);
    }

    expect(events[0].author).toBe('sub_agent2');
  });
});

describe('Runner with plugins', () => {
  let plugin: MockPlugin;
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let runner: Runner;

  beforeEach(() => {
    plugin = new MockPlugin();
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    runner = new Runner({
      appName: TEST_APP_ID,
      agent: new MockLlmAgent('test_agent'),
      sessionService,
      artifactService,
      plugins: [plugin],
    });
  });

  async function runTest(originalUserInput = 'Hello'): Promise<Event[]> {
    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: {role: 'user', parts: [{text: originalUserInput}]},
    })) {
      events.push(event);
    }
    return events;
  }

  it('should initialize with plugins', async () => {
    await runTest();
    expect(runner.pluginManager).toBeDefined();
  });

  it('should modify user message before execution', async () => {
    const originalUserInput = 'original_input';
    plugin.enableUserMessageCallback = true;

    await runTest(originalUserInput);
    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const generatedEvent = session!.events[0];
    const modifiedUserMessage = generatedEvent.content!.parts![0].text;

    expect(modifiedUserMessage).toEqual(MockPlugin.ON_USER_CALLBACK_MSG);
  });

  it('should modify event after execution', async () => {
    plugin.enableEventCallback = true;

    const events = await runTest();
    const generatedEvent = events[0];
    const modifiedEventMessage = generatedEvent.content!.parts![0].text;

    expect(modifiedEventMessage).toEqual(MockPlugin.ON_EVENT_CALLBACK_MSG);
  });

  it('should call beforeRunCallback and stop execution', async () => {
    plugin.enableBeforeRunCallback = true;

    const events = await runTest();
    expect(events.length).toBe(1);
    const event = events[0];
    expect(event.content?.parts?.[0].text).toEqual(
      MockPlugin.BEFORE_RUN_CALLBACK_MSG,
    );
    expect(event.author).toEqual('model');
  });

  it('should call afterRunCallback', async () => {
    await runTest();
    expect(plugin.afterRunCallbackCalled).toBe(true);
  });

  it('should invoke onEventCallback once per streamed function-response event', async () => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    plugin = new MockPlugin();
    runner = new Runner({
      appName: TEST_APP_ID,
      agent: new StreamedFunctionResponseAgent('stream_agent'),
      sessionService,
      artifactService,
      plugins: [plugin],
    });

    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(plugin.onEventFunctionResponseCount).toBe(3);
    expect(plugin.onEventCallbackInvocationCount).toBe(3);
  });

  it('should append each streamed function-response event independently', async () => {
    class CountingSessionService extends InMemorySessionService {
      appendEventCallCount = 0;
      functionResponseAppendCount = 0;

      override async appendEvent(params: {
        session: Parameters<
          InMemorySessionService['appendEvent']
        >[0]['session'];
        event: Parameters<InMemorySessionService['appendEvent']>[0]['event'];
      }) {
        this.appendEventCallCount++;
        if (
          params.event.content?.parts?.some((part) => part.functionResponse)
        ) {
          this.functionResponseAppendCount++;
        }
        return await super.appendEvent(params);
      }
    }

    const countingSessionService = new CountingSessionService();
    runner = new Runner({
      appName: TEST_APP_ID,
      agent: new StreamedFunctionResponseAgent('stream_agent'),
      sessionService: countingSessionService,
      artifactService: new InMemoryArtifactService(),
    });

    await countingSessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    for await (const _event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
    })) {
      // consume
    }

    // 1 append for user input + 3 appends for streamed function responses.
    expect(countingSessionService.appendEventCallCount).toBe(4);
    expect(countingSessionService.functionResponseAppendCount).toBe(3);
  });
});

describe('Runner error handling', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
  });

  async function runTestExpectingError(
    runner: Runner,
    sessionId: string,
    userId: string,
  ): Promise<Error | null> {
    try {
      for await (const event of runner.runAsync({
        userId,
        sessionId,
        newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
      })) {
        console.log('Unexpected event:', event);
      }
      return null;
    } catch (e) {
      return e as Error;
    }
  }

  it('should throw clear error when appName is not configured in runner', async () => {
    const agent = new MockLlmAgent('test_agent');
    // @ts-expect-error - Intentionally omitting appName to test error handling
    const runner = new Runner({
      agent: agent,
      sessionService,
      artifactService,
    });

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const error = await runTestExpectingError(
      runner,
      session.id,
      session.userId,
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain(
      'appName must be provided in runner constructor',
    );
  });

  it('should throw session not found error when session does not exist', async () => {
    const agent = new MockLlmAgent('test_agent');

    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: agent,
      sessionService,
      artifactService,
    });

    const nonExistentSessionId = 'non_existent_session_id';

    const error = await runTestExpectingError(
      runner,
      nonExistentSessionId,
      TEST_USER_ID,
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain(
      `Session not found: ${nonExistentSessionId}`,
    );
  });
});
