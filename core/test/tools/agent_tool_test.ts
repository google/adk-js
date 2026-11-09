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
import {describe, expect, it, vi} from 'vitest';

import {z} from 'zod/v4';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation(function (config) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: vi.fn(),
      };
    }),
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

    vi.mocked(Runner).mockImplementation(function (config) {
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

    vi.mocked(Runner).mockImplementation(function (config) {
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

    vi.mocked(Runner).mockImplementation(function (config) {
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

    vi.mocked(Runner).mockImplementation(function (config) {
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

    vi.mocked(Runner).mockImplementation(function (config) {
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

    vi.mocked(Runner).mockImplementation(function (config) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

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

    vi.mocked(Runner).mockImplementation(function (config) {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

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

    vi.mocked(Runner).mockImplementation(function (config) {
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

  describe('inputSchema and outputSchema validation', () => {
    it('test_custom_schema', async () => {
      const subAgent = new LlmAgent({
        name: 'custom_schema_agent',
        description: 'Agent with custom input and output schemas',
        inputSchema: z.object({
          query: z.string(),
          optionalNote: z.string().nullable().optional(),
        }),
        outputSchema: z.object({
          answer: z.string(),
          confidence: z.number(),
          debugInfo: z.string().nullable().optional(),
        }),
      });

      const tool = new AgentTool({agent: subAgent});
      const session = createSession({
        id: 'parent-session',
        appName: 'custom_schema_agent',
        userId: 'parent-user',
      });
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: subAgent,
        session,
        pluginManager: new PluginManager([]),
      });
      const toolContext = new Context({invocationContext});

      let capturedMessageText = '';
      const mockRunAsync = vi.fn().mockImplementation(async function* (params: {
        newMessage?: {parts?: Array<{text?: string}>};
      }) {
        capturedMessageText = params.newMessage?.parts?.[0]?.text ?? '';
        yield createEvent({
          author: 'custom_schema_agent',
          content: {
            role: 'model',
            parts: [
              {
                text: JSON.stringify({
                  answer: 'validated response',
                  confidence: 0.95,
                  debugInfo: null,
                }),
              },
            ],
          },
        });
      });

      vi.mocked(Runner).mockImplementation(function (config) {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      const result = await tool.runAsync({
        args: {query: 'test query', optionalNote: null},
        toolContext,
      });

      expect(JSON.parse(capturedMessageText)).toEqual({query: 'test query'});
      expect(result).toEqual({
        answer: 'validated response',
        confidence: 0.95,
      });
    });

    it('rejects invalid input args against inputSchema and invalid output JSON against outputSchema', async () => {
      const subAgent = new LlmAgent({
        name: 'strict_schema_agent',
        inputSchema: z.object({
          count: z.number(),
        }),
        outputSchema: z.object({
          total: z.number(),
        }),
      });

      const tool = new AgentTool({agent: subAgent});
      const session = createSession({
        id: 'parent-session',
        appName: 'strict_schema_agent',
        userId: 'parent-user',
      });
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: subAgent,
        session,
        pluginManager: new PluginManager([]),
      });
      const toolContext = new Context({invocationContext});

      await expect(
        tool.runAsync({
          args: {count: 'not-a-number'},
          toolContext,
        }),
      ).rejects.toThrow();

      const invalidOutputRunAsync = async function* () {
        yield createEvent({
          author: 'strict_schema_agent',
          content: {
            role: 'model',
            parts: [{text: JSON.stringify({total: 'invalid-total'})}],
          },
        });
      };

      vi.mocked(Runner).mockImplementation(function (config) {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: invalidOutputRunAsync,
        } as unknown as Runner;
      });

      await expect(
        tool.runAsync({
          args: {count: 3},
          toolContext,
        }),
      ).rejects.toThrow();
    });

    it('test_no_schema', async () => {
      const toolAgent = new LlmAgent({
        name: 'tool_agent',
        description: 'Agent without explicit input or output schema',
      });
      const tool = new AgentTool({agent: toolAgent});
      const session = createSession({
        id: 'parent-session',
        appName: 'tool_agent',
        userId: 'parent-user',
      });
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: toolAgent,
        session,
        pluginManager: new PluginManager([]),
      });
      const toolContext = new Context({invocationContext});

      let capturedRequestText = '';
      const mockRunAsync = vi.fn().mockImplementation(async function* (params: {
        newMessage?: {parts?: Array<{text?: string}>};
      }) {
        capturedRequestText = params.newMessage?.parts?.[0]?.text ?? '';
        yield createEvent({
          author: 'tool_agent',
          content: {
            role: 'model',
            parts: [{text: 'response1'}],
          },
        });
      });

      vi.mocked(Runner).mockImplementation(function (config) {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      const result = await tool.runAsync({
        args: {request: 'test1'},
        toolContext,
      });

      expect(capturedRequestText).toBe('test1');
      expect(result).toBe('response1');
    });

    it('test_update_state', async () => {
      const toolAgent = new LlmAgent({
        name: 'tool_agent',
        instruction: 'input: {state_1}',
      });
      const tool = new AgentTool({agent: toolAgent});
      const sessionService = new InMemorySessionService();
      const session = createSession({
        id: 'parent-session',
        appName: 'tool_agent',
        userId: 'parent-user',
        state: {state_1: 'state1_value'},
      });
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: toolAgent,
        session,
        pluginManager: new PluginManager([]),
        sessionService,
      });
      const toolContext = new Context({invocationContext});

      const mockRunAsync = async function* () {
        const subSession = await sessionService.getSession({
          appName: 'tool_agent',
          userId: 'parent-user',
          sessionId: 'parent-session',
        });
        expect(subSession?.state['state_1']).toBe('state1_value');
        yield createEvent({
          author: 'tool_agent',
          content: {
            role: 'model',
            parts: [{text: '{"custom_output": "response1"}'}],
          },
          actions: createEventActions({
            stateDelta: {state_1: 'changed_value'},
          }),
        });
      };

      vi.mocked(Runner).mockImplementation(function (config) {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      const result = await tool.runAsync({
        args: {request: 'test1'},
        toolContext,
      });

      expect(result).toBe('{"custom_output": "response1"}');
      expect(toolContext.state.get('state_1')).toBe('changed_value');
    });

    it('concatenates multiple non-thought text parts from the final event', async () => {
      const plainAgent = new LlmAgent({
        name: 'multi_part_plain_agent',
      });
      const plainTool = new AgentTool({agent: plainAgent});
      const session = createSession({
        id: 'parent-session',
        appName: 'multi_part_plain_agent',
        userId: 'parent-user',
      });
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: plainAgent,
        session,
        pluginManager: new PluginManager([]),
      });
      const toolContext = new Context({invocationContext});

      const multiPartPlainRun = async function* () {
        yield createEvent({
          author: 'multi_part_plain_agent',
          content: {
            role: 'model',
            parts: [
              {text: 'thought chunk', thought: true},
              {text: 'line one'},
              {text: 'line two'},
            ],
          },
        });
      };

      vi.mocked(Runner).mockImplementation(function (config) {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: multiPartPlainRun,
        } as unknown as Runner;
      });

      const plainResult = await plainTool.runAsync({
        args: {request: 'combine lines'},
        toolContext,
      });
      expect(plainResult).toBe('line one\nline two');

      const schemaAgent = new LlmAgent({
        name: 'multi_part_schema_agent',
        outputSchema: z.object({
          status: z.string(),
          count: z.number(),
        }),
      });
      const schemaTool = new AgentTool({agent: schemaAgent});

      const multiPartSchemaRun = async function* () {
        yield createEvent({
          author: 'multi_part_schema_agent',
          content: {
            role: 'model',
            parts: [{text: '{"status": "ok",'}, {text: '"count": 2}'}],
          },
        });
      };

      vi.mocked(Runner).mockImplementation(function (config) {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: multiPartSchemaRun,
        } as unknown as Runner;
      });

      const schemaResult = await schemaTool.runAsync({
        args: {request: 'combine json'},
        toolContext,
      });
      expect(schemaResult).toEqual({status: 'ok', count: 2});
    });
  });
});
