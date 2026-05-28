/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  createEvent,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_confirmation_llm_request_processor.js';

vi.mock('../../../src/agents/functions.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/agents/functions.js')>();
  return {
    ...original,
    handleFunctionCallList: vi.fn().mockResolvedValue(null),
  };
});

class MockRootAgent extends BaseAgent {
  constructor(name: string, subAgents: BaseAgent[] = []) {
    super({name, subAgents});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createMockInvocationContext(
  agent: BaseAgent,
  events: ReturnType<typeof createEvent>[] = [],
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events,
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function makeLlmRequest(): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

async function collectEvents(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest = makeLlmRequest(),
) {
  const events = [];
  for await (const event of REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    events.push(event);
  }
  return events;
}

describe('RequestConfirmationLlmRequestProcessor', () => {
  it('should do nothing if agent is not an LlmAgent', async () => {
    const agent = new MockRootAgent('test_agent');
    const invocationContext = createMockInvocationContext(agent);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should do nothing if session has no events', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent, []);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should do nothing if there are no function responses in user events', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const userEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {role: 'user', parts: [{text: 'Hello'}]},
    });
    const invocationContext = createMockInvocationContext(agent, [userEvent]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should do nothing if user event has non-confirmation function response', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const userEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'some_other_function',
              response: {result: 'done'},
            },
          },
        ],
      },
    });
    const invocationContext = createMockInvocationContext(agent, [userEvent]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should do nothing if no prior function call event found', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    // Only a user event with confirmation response, no prior function call event
    const userConfirmationEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-confirm-1',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {
                confirmed: true,
                hint: '',
              },
            },
          },
        ],
      },
    });
    const invocationContext = createMockInvocationContext(agent, [
      userConfirmationEvent,
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should yield event when handleFunctionCallList returns an event', async () => {
    const {handleFunctionCallList} =
      await import('../../../src/agents/functions.js');
    const mockFunctionCallList = vi.mocked(handleFunctionCallList);

    const fakeResponseEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              id: 'original-fc-1',
              name: 'my_tool',
              response: {result: 'ok'},
            },
          },
        ],
      },
    });
    mockFunctionCallList.mockResolvedValueOnce(fakeResponseEvent);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);

    const originalFunctionCall = {
      id: 'original-fc-1',
      name: 'my_tool',
      args: {param: 'value'},
    };

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-1',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall},
            },
          },
        ],
      },
    });

    const userConfirmationEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-confirm-1',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {
                response: JSON.stringify({confirmed: true, hint: 'ok'}),
              },
            },
          },
        ],
      },
    });

    const invocationContext = createMockInvocationContext(agent, [
      systemFunctionCallEvent,
      userConfirmationEvent,
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(fakeResponseEvent);
  });

  it('should yield no events when handleFunctionCallList returns null', async () => {
    const {handleFunctionCallList} =
      await import('../../../src/agents/functions.js');
    const mockFunctionCallList = vi.mocked(handleFunctionCallList);
    mockFunctionCallList.mockResolvedValueOnce(null);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);

    const originalFunctionCall = {
      id: 'original-fc-2',
      name: 'my_tool',
      args: {},
    };

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-2',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall},
            },
          },
        ],
      },
    });

    const userConfirmationEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-confirm-2',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {confirmed: true, hint: ''},
            },
          },
        ],
      },
    });

    const invocationContext = createMockInvocationContext(agent, [
      systemFunctionCallEvent,
      userConfirmationEvent,
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should skip tools that have already been resumed after the confirmation event', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);

    const originalFunctionCall = {
      id: 'original-fc-3',
      name: 'my_tool',
      args: {},
    };

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-3',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall},
            },
          },
        ],
      },
    });

    const userConfirmationEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-confirm-3',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {confirmed: true, hint: ''},
            },
          },
        ],
      },
    });

    // A subsequent event that already has the tool response for the same original call id
    const alreadyResumedEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              id: 'original-fc-3',
              name: 'my_tool',
              response: {result: 'already done'},
            },
          },
        ],
      },
    });

    const invocationContext = createMockInvocationContext(agent, [
      systemFunctionCallEvent,
      userConfirmationEvent,
      alreadyResumedEvent,
    ]);

    // Since the original tool was already resumed, processor yields nothing
    const events = await collectEvents(invocationContext);
    expect(events).toHaveLength(0);
  });
});
