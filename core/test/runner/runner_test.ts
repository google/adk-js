/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'jasmine';

import {Content, FunctionCall, FunctionResponse, Part} from '@google/genai';

import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {InMemoryArtifactService} from '../../src/artifacts/in_memory_artifact_service.js';
import {Event} from '../../src/events/event.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {Session} from '../../src/sessions/session.js';

const TEST_APP_ID = 'test_app_id';
const TEST_USER_ID = 'test_user_id';
const TEST_SESSION_ID = 'test_session_id';
const TEST_MESSAGE = 'test_message';

class MockAgent extends BaseAgent {
  constructor(name: string, parentAgent?: BaseAgent) {
    super({name, parentAgent});
  }

  protected override async *
      runAsyncImpl(context: InvocationContext):
          AsyncGenerator<Event, void, void> {
    yield new Event({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Test response'}]},
    });
  }

  protected override async *
      runLiveImpl(context: InvocationContext):
          AsyncGenerator<Event, void, void> {
    throw new Error('Not implemented');
  }
}

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

  protected override async *
      runAsyncImpl(context: InvocationContext):
          AsyncGenerator<Event, void, void> {
    yield new Event({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Test LLM response'}]},
    });
  }
}

class MockPlugin extends BasePlugin {
  static ON_USER_CALLBACK_MSG =
      'Modified user message ON_USER_CALLBACK_MSG from MockPlugin';
  static ON_EVENT_CALLBACK_MSG =
      'Modified event ON_EVENT_CALLBACK_MSG from MockPlugin';

  enableUserMessageCallback = false;
  enableEventCallback = false;

  constructor() {
    super('mock_plugin');
  }

  override async onUserMessageCallback(
      {invocationContext, userMessage}:
          {invocationContext: InvocationContext; userMessage: Content;},
      ): Promise<Content|undefined> {
    if (!this.enableUserMessageCallback) {
      return undefined;
    }
    return {
      role: 'model',
      parts: [{text: MockPlugin.ON_USER_CALLBACK_MSG}],
    };
  }

  override async onEventCallback({invocationContext, event}: {
    invocationContext: InvocationContext; event: Event;
  }): Promise<Event|undefined> {
    if (!this.enableEventCallback) {
      return undefined;
    }
    return new Event({
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
    nonTransferableAgent =
        new MockLlmAgent('non_transferable', true, rootAgent);
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

    const events = await runner.runSync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]}
    });

    return events;
  }

  it('should find agent when last event is function response', async () => {
    console.log('should find agent when last event is function response');
    const functionCall:
        FunctionCall = {id: 'func_123', name: 'test_func', args: {}};
    const functionResponse:
        FunctionResponse = {id: 'func_123', name: 'test_func', response: {}};

    const callEvent = new Event({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{functionCall}]},
    });

    const responseEvent = new Event({
      invocationId: 'inv2',
      author: 'user',
      content: {role: 'user', parts: [{functionResponse}]},
    });

    const events = await runTest([callEvent, responseEvent]);

    expect(events[0].author).toBe('sub_agent1');
  });

  it('should return root agent when session has no non-user events',
     async () => {
       console.log(
           'should return root agent when session has no non-user events');

       const nonUserEvent = new Event({
         invocationId: 'inv1',
         author: 'user',
         content: {role: 'user', parts: [{text: 'Hello'}]},
       });

       const events = await runTest([nonUserEvent]);

       expect(events[0].author).toBe('root_agent');
     });

  it('should return root agent when it is found in session events',
     async () => {
       console.log(
           'should return root agent when it is found in session events');

       const rootEvent = new Event({
         invocationId: 'inv1',
         author: 'root_agent',
         content: {role: 'model', parts: [{text: 'Root response'}]},
       });

       const events = await runTest([rootEvent]);

       expect(events[0].author).toBe('root_agent');
     });

  it('should return transferable sub agent when found', async () => {
    console.log('should return transferable sub agent when found');

    const subAgent1Event = new Event({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'Sub agent response'}]},
    });

    const events = await runTest([subAgent1Event]);

    expect(events[0].author).toBe('sub_agent1');
  });

  it('should skip non-transferable agent and return root agent', async () => {
    console.log('should skip non-transferable agent and return root agent');

    const nonTransferableResponse = new Event({
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
    console.log('should skip unknown agent and return root agent');
    const session = new Session({
      id: TEST_SESSION_ID,
      userId: TEST_USER_ID,
      appName: TEST_APP_ID,
      events: [
        new Event({
          invocationId: 'inv1',
          author: 'unknown_agent',
          content: {
            role: 'model',
            parts: [{text: 'Unknown agent response'}],
          },
        }),
        new Event({
          invocationId: 'inv2',
          author: 'root_agent',
          content: {role: 'model', parts: [{text: 'Root response'}]},
        }),
      ],
    });

    const unknownEvent = new Event({
      invocationId: 'inv1',
      author: 'unknown_agent',
      content: {
        role: 'model',
        parts: [{text: 'Unknown agent response'}],
      },
    });

    const rootAgentEvent = new Event({
      invocationId: 'inv2',
      author: 'root_agent',
      content: {role: 'model', parts: [{text: 'Root response'}]},
    });

    const events = await runTest([unknownEvent, rootAgentEvent]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should prioritize function response scenario', async () => {
    console.log('should prioritize function response scenario');
    const functionCall:
        FunctionCall = {id: 'func_456', name: 'test_func', args: {}};
    const functionResponse:
        FunctionResponse = {id: 'func_456', name: 'test_func', response: {}};

    const callEvent = new Event({
      invocationId: 'inv1',
      author: 'sub_agent2',
      content: {role: 'model', parts: [{functionCall}]},
    });

    const rootEvent = new Event({
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

    const events = await runner.runSync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{functionResponse}]}
    });

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
      sessionId: TEST_SESSION_ID
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
      sessionId: TEST_SESSION_ID
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
});
