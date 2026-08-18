/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseSessionService,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  ToolConfirmation,
  createEvent,
  createEventActions,
  createSession,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
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
  sessionService?: BaseSessionService,
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
    sessionService,
    pluginManager: new PluginManager([]),
  });
}

async function collectEvents(invocationContext: InvocationContext) {
  const events = [];
  for await (const event of REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
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

  it('should stage the tool response in the session without writing it', async () => {
    // The content builder runs behind this processor in the same step and
    // reads `session.events`, so the response has to be there. Writing it
    // through the session service is the runner's job: it appends every event
    // it is yielded, and a backend that does not dedupe by event id — Vertex
    // posts to Agent Engine unconditionally — would store this one twice.
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
              id: 'original-fc-4',
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

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-4',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {
                originalFunctionCall: {
                  id: 'original-fc-4',
                  name: 'my_tool',
                  args: {param: 'value'},
                },
              },
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
              id: 'fc-confirm-4',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {confirmed: true, hint: ''},
            },
          },
        ],
      },
    });

    const sessionService = new InMemorySessionService();
    const appendEvent = vi.spyOn(sessionService, 'appendEvent');
    const invocationContext = createMockInvocationContext(
      agent,
      [systemFunctionCallEvent, userConfirmationEvent],
      sessionService,
    );

    const events = await collectEvents(invocationContext);

    expect(events).toEqual([fakeResponseEvent]);
    expect(invocationContext.session.events.at(-1)).toBe(fakeResponseEvent);
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('should replace a staged response already in the session rather than duplicating it', async () => {
    // The processor re-runs on every LLM step of the invocation. Staging the
    // same response twice would show the model the same tool result twice.
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
              id: 'original-fc-5',
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

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-5',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {
                originalFunctionCall: {
                  id: 'original-fc-5',
                  name: 'my_tool',
                  args: {},
                },
              },
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
              id: 'fc-confirm-5',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {confirmed: true, hint: ''},
            },
          },
        ],
      },
    });

    // A stale copy of the very same event, as an earlier step staged it. It is
    // the gate's own response id, so it does not count as the tool's result.
    const staleCopy = {...fakeResponseEvent, content: undefined};
    const invocationContext = createMockInvocationContext(agent, [
      systemFunctionCallEvent,
      userConfirmationEvent,
      staleCopy,
    ]);

    await collectEvents(invocationContext);

    const staged = invocationContext.session.events.filter(
      (event) => event.id === fakeResponseEvent.id,
    );
    expect(staged).toEqual([fakeResponseEvent]);
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

// --- Approval lifecycle ------------------------------------------------------
//
// An approval authorizes one execution of one action, in the turn it was given,
// on the branch that asked for it. These drive the processor over faithful
// session histories — the model's call, the tool's "requires confirmation"
// placeholder, the gate, the decision — and assert which pinned calls reach
// `handleFunctionCallList`.

const AGENT_NAME = 'finance_agent';

const wireTransferCall: FunctionCall = {
  id: 'call-1',
  name: 'wire_transfer',
  args: {amount: 10, recipient: 'Alice'},
};

/** The events a real pause writes for one gated call. */
function pausedCallEvents(
  options: {call?: FunctionCall; gateId?: string; branch?: string} = {},
): Event[] {
  const call = options.call ?? wireTransferCall;
  const gateId = options.gateId ?? 'gate-1';
  const toolConfirmation = {hint: 'Approve?', confirmed: false};
  const common = {invocationId: 'test-invocation', branch: options.branch};
  return [
    createEvent({
      ...common,
      author: AGENT_NAME,
      content: {role: 'model', parts: [{functionCall: call}]},
    }),
    createEvent({
      ...common,
      author: AGENT_NAME,
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {error: 'This tool call requires confirmation.'},
            },
          },
        ],
      },
      actions: createEventActions({
        requestedToolConfirmations: {
          [call.id!]: new ToolConfirmation(toolConfirmation),
        },
      }),
    }),
    createEvent({
      ...common,
      author: AGENT_NAME,
      content: {
        role: 'user',
        parts: [
          {
            functionCall: {
              id: gateId,
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall: call, toolConfirmation},
            },
          },
        ],
      },
      longRunningToolIds: [gateId],
    }),
  ];
}

/** The user's structured decision on one or more gates. */
function approvalEvent(gateIds: string[], confirmed = true): Event {
  return createEvent({
    invocationId: 'test-invocation',
    author: 'user',
    content: {
      role: 'user',
      parts: gateIds.map((id) => ({
        functionResponse: {
          id,
          name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
          response: {confirmed},
        },
      })),
    },
  });
}

/** The response event a resumed execution leaves behind. */
function toolResponseEvent(call: FunctionCall): Event {
  return createEvent({
    invocationId: 'test-invocation',
    author: AGENT_NAME,
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: call.id,
            name: call.name,
            response: {result: 'done'},
          },
        },
      ],
    },
  });
}

function userTextEvent(text: string): Event {
  return createEvent({
    invocationId: 'test-invocation',
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

describe('RequestConfirmationLlmRequestProcessor approval lifecycle', () => {
  let resumedCalls: FunctionCall[] = [];
  let decisions: Record<string, ToolConfirmation> = {};

  beforeEach(async () => {
    const {handleFunctionCallList} =
      await import('../../../src/agents/functions.js');
    const mock = vi.mocked(handleFunctionCallList);
    mock.mockClear();
    resumedCalls = [];
    decisions = {};
    mock.mockImplementation(async ({functionCalls, toolConfirmationDict}) => {
      resumedCalls = functionCalls;
      decisions = toolConfirmationDict ?? {};
      return null;
    });
  });

  async function run(
    events: Event[],
    options: {branch?: string; plainText?: boolean} = {},
  ): Promise<void> {
    const agent = new LlmAgent({name: AGENT_NAME, model: 'gemini-2.5-flash'});
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      branch: options.branch,
      session: createSession({
        id: 'test-session',
        events,
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
      runConfig: options.plainText
        ? {plainTextToolConfirmation: true}
        : undefined,
    });
    await collectEvents(invocationContext);
  }

  it('resumes the pinned call on a fresh approval', async () => {
    // The paused call already has a response — the placeholder that raised the
    // gate — which must not read as "already executed".
    await run([...pausedCallEvents(), approvalEvent(['gate-1'])]);

    expect(resumedCalls).toEqual([wireTransferCall]);
  });

  it('spends an approval once, so a replay does not run the tool again', async () => {
    await run([
      ...pausedCallEvents(),
      approvalEvent(['gate-1']),
      toolResponseEvent(wireTransferCall),
      userTextEvent('Thanks!'),
      approvalEvent(['gate-1']),
    ]);

    expect(resumedCalls).toEqual([]);
  });

  it('spends a denial too', async () => {
    await run([
      ...pausedCallEvents(),
      approvalEvent(['gate-1'], false),
      toolResponseEvent(wireTransferCall),
      userTextEvent('Thanks!'),
      approvalEvent(['gate-1'], false),
    ]);

    expect(resumedCalls).toEqual([]);
  });

  it('ignores an approval that is no longer the latest user turn', async () => {
    // Never resolved — but the user has moved on, and the decision belongs to
    // a turn that is over.
    await run([
      ...pausedCallEvents(),
      approvalEvent(['gate-1']),
      userTextEvent('Actually, what were the fees again?'),
    ]);

    expect(resumedCalls).toEqual([]);
  });

  it('ignores a gate raised on a sibling branch', async () => {
    await run(
      [
        ...pausedCallEvents({branch: 'root.sibling'}),
        approvalEvent(['gate-1']),
      ],
      {branch: 'root.current'},
    );

    expect(resumedCalls).toEqual([]);
  });

  it('resumes a gate raised on an ancestor branch', async () => {
    await run(
      [...pausedCallEvents({branch: 'root'}), approvalEvent(['gate-1'])],
      {branch: 'root.current'},
    );

    expect(resumedCalls).toEqual([wireTransferCall]);
  });

  it('resumes two gates from different turns approved together', async () => {
    const secondCall: FunctionCall = {
      id: 'call-2',
      name: 'wire_transfer',
      args: {amount: 25, recipient: 'Bob'},
    };

    await run([
      ...pausedCallEvents(),
      ...pausedCallEvents({call: secondCall, gateId: 'gate-2'}),
      approvalEvent(['gate-1', 'gate-2']),
    ]);

    expect(resumedCalls).toEqual([wireTransferCall, secondCall]);
  });

  it('skips a confirmation response with no id and one with no payload', async () => {
    await run([
      ...pausedCallEvents(),
      createEvent({
        invocationId: 'test-invocation',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                response: {confirmed: true},
              },
            },
            {
              functionResponse: {
                id: 'gate-1',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              },
            },
          ],
        },
      }),
    ]);

    expect(resumedCalls).toEqual([]);
  });

  it('ignores a gate whose pinned call is absent, malformed, or unidentified', async () => {
    await run([
      createEvent({
        invocationId: 'test-invocation',
        author: AGENT_NAME,
        content: {
          role: 'user',
          parts: [
            {
              functionCall: {
                id: 'gate-no-pin',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {toolConfirmation: {confirmed: false}},
              },
            },
            {
              functionCall: {
                id: 'gate-array-pin',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {originalFunctionCall: ['not', 'an', 'object']},
              },
            },
            {
              functionCall: {
                id: 'gate-pin-without-id',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {originalFunctionCall: {name: 'wire_transfer', args: {}}},
              },
            },
            {functionCall: {name: 'call_without_an_id', args: {}}},
          ],
        },
      }),
      approvalEvent(['gate-no-pin', 'gate-array-pin', 'gate-pin-without-id']),
    ]);

    expect(resumedCalls).toEqual([]);
  });

  // The plain-text fallback answers a gate with a typed "yes"/"no", for
  // interactive clients like `adk run`. It is opt-in, and stays bound to the
  // single gate the reply immediately follows.
  describe('plain-text fallback', () => {
    it('resolves the gate the reply follows, past a trailing agent event', async () => {
      await run(
        [
          ...pausedCallEvents(),
          userTextEvent('yes'),
          createEvent({
            invocationId: 'test-invocation',
            author: AGENT_NAME,
            content: {role: 'model', parts: [{text: 'working on it'}]},
          }),
        ],
        {plainText: true},
      );

      expect(resumedCalls).toEqual([wireTransferCall]);
      expect(decisions['call-1'].confirmed).toBe(true);
    });

    it('reads a typed denial as a denial', async () => {
      await run([...pausedCallEvents(), userTextEvent('no')], {
        plainText: true,
      });

      expect(resumedCalls).toEqual([wireTransferCall]);
      expect(decisions['call-1'].confirmed).toBe(false);
    });

    it('does not answer a gate when the latest user turn is not plain text', async () => {
      await run(
        [
          ...pausedCallEvents(),
          createEvent({
            invocationId: 'test-invocation',
            author: 'user',
            content: {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'unrelated-1',
                    name: 'some_other_tool',
                    response: {ok: true},
                  },
                },
              ],
            },
          }),
        ],
        {plainText: true},
      );

      expect(resumedCalls).toEqual([]);
    });

    it('does not answer a gate from a user turn with no content at all', async () => {
      await run(
        [
          ...pausedCallEvents(),
          createEvent({invocationId: 'test-invocation', author: 'user'}),
        ],
        {plainText: true},
      );

      expect(resumedCalls).toEqual([]);
    });

    it('skips a gate an earlier turn already answered', async () => {
      const secondCall: FunctionCall = {
        id: 'call-2',
        name: 'wire_transfer',
        args: {amount: 25, recipient: 'Bob'},
      };

      await run(
        [
          ...pausedCallEvents(),
          approvalEvent(['gate-1']),
          toolResponseEvent(wireTransferCall),
          ...pausedCallEvents({call: secondCall, gateId: 'gate-2'}),
          userTextEvent('yes'),
        ],
        {plainText: true},
      );

      expect(resumedCalls).toEqual([secondCall]);
    });

    it('does not reach back past an intervening user turn', async () => {
      await run(
        [...pausedCallEvents(), userTextEvent('hold on'), userTextEvent('yes')],
        {plainText: true},
      );

      expect(resumedCalls).toEqual([]);
    });

    it('leaves the gate pending on text that decides nothing', async () => {
      await run([...pausedCallEvents(), userTextEvent('what does that do?')], {
        plainText: true,
      });

      expect(resumedCalls).toEqual([]);
    });

    it('stays off unless the run opts in', async () => {
      await run([...pausedCallEvents(), userTextEvent('yes')]);

      expect(resumedCalls).toEqual([]);
    });
  });
});
