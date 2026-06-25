/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  Context,
  createEvent,
  createEventActions,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Runner,
  State,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation((config) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: vi.fn(),
    })),
  };
});

describe('AgentTool', () => {
  it('propagates session context and state delta', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    vi.spyOn(mockSessionService, 'getOrCreateSession');

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      sessionService: mockSessionService,
    });

    const toolContext = new Context({
      invocationContext,
    });

    vi.spyOn(toolContext.state, 'update');

    // Setup Runner mock to return some events
    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
        actions: createEventActions({
          stateDelta: {someKey: 'someValue'},
        }),
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('hello');

    // Verify getOrCreateSession called with parent context
    expect(mockSessionService.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'sub-agent',
        userId: 'parent-user',
        sessionId: 'parent-session',
      }),
    );

    // Verify state update called with sub-agent's state delta
    expect(toolContext.state.update).toHaveBeenCalledWith({
      someKey: 'someValue',
    });
  });

  it('reuses existing session on second invocation within the same parent session', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    vi.spyOn(mockSessionService, 'getOrCreateSession').mockResolvedValue(
      createSession({
        id: 'parent-session',
        appName: 'sub-agent',
        userId: 'parent-user',
      }),
    );

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      sessionService: mockSessionService,
    });

    const toolContext = new Context({invocationContext});

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'result'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    // Invoke twice simulating two turns in the same parent session
    await tool.runAsync({args: {request: 'first'}, toolContext});
    await tool.runAsync({args: {request: 'second'}, toolContext});

    // getOrCreateSession should be called twice, returning the existing
    // session on the second call rather than throwing a duplicate-session error
    expect(mockSessionService.getOrCreateSession).toHaveBeenCalledTimes(2);
    expect(mockSessionService.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: 'parent-session'}),
    );
  });

  it('strips thought parts from the merged result', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
    });

    const toolContext = new Context({invocationContext});

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {
          role: 'model',
          parts: [
            {text: 'reasoning about the user request', thought: true},
            {text: 'final answer'},
          ],
        },
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('final answer');
  });

  it('handles abort signal before execution', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const controller = new AbortController();

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      abortSignal: controller.signal,
    });

    const toolContext = new Context({
      invocationContext,
    });
    controller.abort();

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('');
  });

  it('does not set skipSummarization on toolContext actions when skipSummarization is true', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent, skipSummarization: true});

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
    });

    const toolContext = new Context({
      invocationContext,
    });

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'result'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    await tool.runAsync({args: {request: 'hello'}, toolContext});

    // skipSummarization must NOT be set on the parent's EventActions.
    // Setting it would cause isFinalResponse() to treat the tool-response
    // event as terminal, prematurely breaking the parent agent's run loop.
    expect(toolContext.actions.skipSummarization).toBeFalsy();
  });

  it('handles abort signal during execution', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const controller = new AbortController();

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      abortSignal: controller.signal,
    });

    const toolContext = new Context({
      invocationContext,
    });

    // Setup Runner mock to yield an event and then abort
    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
      controller.abort();
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'world'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    // The method should return undefined (void) when aborted during loop
    expect(result).toBeUndefined();
  });

  it('does not propagate temp: keys from sub-agent state delta to parent', async () => {
    const mockAgent = {name: 'sub-agent'} as unknown as LlmAgent;
    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    const updateMock = vi.fn();

    const toolContext = {
      invocationContext: {
        userId: 'parent-user',
        session: {id: 'parent-session'},
        sessionService: mockSessionService,
      },
      state: {
        toRecord: () => ({}),
        update: updateMock,
      },
    } as unknown as Context;

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'done'}]},
        actions: createEventActions({
          stateDelta: {
            normalKey: 'persistMe',
            [`${State.TEMP_PREFIX}ephemeral`]: 'dropMe',
          },
        }),
      });
    };

    vi.mocked(Runner).mockImplementation(
      (config) =>
        ({
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        }) as unknown as Runner,
    );

    await tool.runAsync({args: {request: 'go'}, toolContext});

    // Only the non-temp key must reach the parent state
    expect(updateMock).toHaveBeenCalledWith({normalKey: 'persistMe'});
    expect(updateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({[`${State.TEMP_PREFIX}ephemeral`]: 'dropMe'}),
    );
  });

  it('skips state.update entirely when all delta keys are temp:', async () => {
    const mockAgent = {name: 'sub-agent'} as unknown as LlmAgent;
    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    const updateMock = vi.fn();

    const toolContext = {
      invocationContext: {
        userId: 'parent-user',
        session: {id: 'parent-session'},
        sessionService: mockSessionService,
      },
      state: {
        toRecord: () => ({}),
        update: updateMock,
      },
    } as unknown as Context;

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'done'}]},
        actions: createEventActions({
          stateDelta: {
            [`${State.TEMP_PREFIX}only`]: 'dropMe',
          },
        }),
      });
    };

    vi.mocked(Runner).mockImplementation(
      (config) =>
        ({
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        }) as unknown as Runner,
    );

    await tool.runAsync({args: {request: 'go'}, toolContext});

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not propagate temp: keys from parent state when creating sub-agent session', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
      state: {
        normalKey: 'parentValue',
        [`${State.TEMP_PREFIX}tempKey`]: 'tempValue',
      },
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      sessionService: mockSessionService,
    });

    const toolContext = new Context({
      invocationContext,
    });

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    // Retrieve the created session from the service
    const subAgentSession = await mockSessionService.getSession({
      appName: 'sub-agent',
      userId: 'parent-user',
      sessionId: 'parent-session',
    });

    expect(subAgentSession).toBeDefined();
    expect(subAgentSession?.state).toHaveProperty('normalKey', 'parentValue');
    expect(subAgentSession?.state).not.toHaveProperty(
      `${State.TEMP_PREFIX}tempKey`,
    );
  });

  describe('Schema Validation', () => {
    const LLM_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.llmAgent');

    it('validates input arguments using Zod schema and succeeds', async () => {
      const schema = z.object({
        query: z.string(),
        count: z.number(),
      });

      const mockAgent = {
        name: 'sub-agent',
        [LLM_AGENT_SIGNATURE_SYMBOL]: true,
        inputSchema: schema,
      } as unknown as LlmAgent;

      const tool = new AgentTool({agent: mockAgent});
      const mockSessionService = new InMemorySessionService();
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: mockAgent,
        session: createSession({
          id: 'parent',
          appName: 'sub-agent',
          userId: 'user',
        }),
        pluginManager: new PluginManager([]),
        sessionService: mockSessionService,
      });
      const toolContext = new Context({invocationContext});

      let receivedContent: Content | undefined;
      const mockRunAsync = async function* (params: {newMessage: Content}) {
        receivedContent = params.newMessage;
        yield createEvent({
          author: 'sub-agent',
          content: {role: 'model', parts: [{text: 'result'}]},
        });
      };

      vi.mocked(Runner).mockImplementation((config) => {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      const result = await tool.runAsync({
        args: {query: 'test', count: 10},
        toolContext,
      });

      expect(result).toBe('result');
      expect(receivedContent).toBeDefined();
      expect(JSON.parse(receivedContent.parts[0].text)).toEqual({
        query: 'test',
        count: 10,
      });
    });

    it('throws error if input validation fails', async () => {
      const schema = z.object({
        query: z.string(),
        count: z.number(),
      });

      const mockAgent = {
        name: 'sub-agent',
        [LLM_AGENT_SIGNATURE_SYMBOL]: true,
        inputSchema: schema,
      } as unknown as LlmAgent;

      const tool = new AgentTool({agent: mockAgent});
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: mockAgent,
        session: createSession({
          id: 'parent',
          appName: 'sub-agent',
          userId: 'user',
        }),
        pluginManager: new PluginManager([]),
      });
      const toolContext = new Context({invocationContext});

      await expect(
        tool.runAsync({
          args: {query: 'test', count: 'not-a-number'},
          toolContext,
        }),
      ).rejects.toThrow('Input validation failed');
    });

    it('validates output using Zod schema and succeeds', async () => {
      const schema = z.object({
        reply: z.string(),
        status: z.number(),
      });

      const mockAgent = {
        name: 'sub-agent',
        [LLM_AGENT_SIGNATURE_SYMBOL]: true,
        outputSchema: schema,
      } as unknown as LlmAgent;

      const tool = new AgentTool({agent: mockAgent});
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: mockAgent,
        session: createSession({
          id: 'parent',
          appName: 'sub-agent',
          userId: 'user',
        }),
        pluginManager: new PluginManager([]),
      });
      const toolContext = new Context({invocationContext});

      const mockRunAsync = async function* () {
        yield createEvent({
          author: 'sub-agent',
          content: {
            role: 'model',
            parts: [{text: JSON.stringify({reply: 'ok', status: 200})}],
          },
        });
      };

      vi.mocked(Runner).mockImplementation((config) => {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      const result = await tool.runAsync({
        args: {request: 'go'},
        toolContext,
      });

      expect(result).toEqual({reply: 'ok', status: 200});
    });

    it('throws error if output validation fails', async () => {
      const schema = z.object({
        reply: z.string(),
        status: z.number(),
      });

      const mockAgent = {
        name: 'sub-agent',
        [LLM_AGENT_SIGNATURE_SYMBOL]: true,
        outputSchema: schema,
      } as unknown as LlmAgent;

      const tool = new AgentTool({agent: mockAgent});
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: mockAgent,
        session: createSession({
          id: 'parent',
          appName: 'sub-agent',
          userId: 'user',
        }),
        pluginManager: new PluginManager([]),
      });
      const toolContext = new Context({invocationContext});

      const mockRunAsync = async function* () {
        yield createEvent({
          author: 'sub-agent',
          content: {
            role: 'model',
            parts: [
              {text: JSON.stringify({reply: 'ok', status: 'not-a-number'})},
            ],
          },
        });
      };

      vi.mocked(Runner).mockImplementation((config) => {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      await expect(
        tool.runAsync({
          args: {request: 'go'},
          toolContext,
        }),
      ).rejects.toThrow('Output validation failed');
    });

    it('skips validation if schema is not Zod (raw GenAI Schema)', async () => {
      const mockAgent = {
        name: 'sub-agent',
        [LLM_AGENT_SIGNATURE_SYMBOL]: true,
        inputSchema: {type: 'OBJECT', properties: {query: {type: 'STRING'}}},
        outputSchema: {type: 'OBJECT', properties: {reply: {type: 'STRING'}}},
      } as unknown as LlmAgent;

      const tool = new AgentTool({agent: mockAgent});
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: mockAgent,
        session: createSession({
          id: 'parent',
          appName: 'sub-agent',
          userId: 'user',
        }),
        pluginManager: new PluginManager([]),
      });
      const toolContext = new Context({invocationContext});

      const mockRunAsync = async function* () {
        yield createEvent({
          author: 'sub-agent',
          content: {
            role: 'model',
            parts: [{text: JSON.stringify({reply: 'ok'})}],
          },
        });
      };

      vi.mocked(Runner).mockImplementation((config) => {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      const result = await tool.runAsync({
        args: {invalidKey: 'value'},
        toolContext,
      });

      expect(result).toEqual({reply: 'ok'});
    });
  });
});
