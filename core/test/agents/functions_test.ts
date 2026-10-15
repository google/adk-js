/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ActiveStreamingTool,
  BasePlugin,
  BaseTool,
  Context,
  createEvent,
  createEventActions,
  createSession,
  Event,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  isToolNotFound,
  LiveRequestQueue,
  LlmAgent,
  LongRunningFunctionTool,
  PluginManager,
  Session,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
  ToolConfirmation,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {Span, SpanStatusCode} from '@opentelemetry/api';
import type {MockInstance} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  findEventByFunctionCallId,
  findMatchingFunctionCall,
  generateClientFunctionCallId,
  getConflictingFunctionResponseAuthors,
  getLongRunningFunctionCalls,
  mergeParallelFunctionResponseEvents,
} from '../../src/agents/functions.js';
import {tracer} from '../../src/telemetry/tracing.js';
import {logger} from '../../src/utils/logger.js';
import {Task} from '../../src/utils/task.js';

// Get the test target function
const {
  handleFunctionCallList,
  handleFunctionCallsLive,
  processFunctionLiveHelper,
  generateAuthEvent,
  generateRequestConfirmationEvent,
} = functionsExportedForTestingOnly;

// Tool for testing
const testTool = new FunctionTool({
  name: 'testTool',
  description: 'test tool',
  parameters: z.object({}),
  execute: async () => {
    return {result: 'tool executed'};
  },
});

const errorTool = new FunctionTool({
  name: 'errorTool',
  description: 'error tool',
  parameters: z.object({}),
  execute: async () => {
    throw new Error('tool error message content');
  },
});

const typedErrorResponseTool = new FunctionTool({
  name: 'typedErrorResponseTool',
  description: 'returns a typed tool error response',
  parameters: z.object({}),
  execute: async () => ({
    error: 'sensitive tool error details',
    errorType: 'MCP_TOOL_ERROR',
  }),
});

class ThrowingTool extends BaseTool {
  constructor(private readonly thrownValue: unknown) {
    super({name: 'throwingTool', description: 'throws a test value'});
  }

  override async runAsync(
    _request: Parameters<BaseTool['runAsync']>[0],
  ): Promise<unknown> {
    throw this.thrownValue;
  }
}

// Plugin for testing
class TestPlugin extends BasePlugin {
  beforeToolCallbackResponse?: Record<string, unknown>;
  afterToolCallbackResponse?: Record<string, unknown>;
  onToolErrorCallbackResponse?: Record<string, unknown>;

  override async beforeToolCallback(
    ..._args: Parameters<BasePlugin['beforeToolCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.beforeToolCallbackResponse) {
      return this.beforeToolCallbackResponse;
    }
    return undefined;
  }

  override async afterToolCallback(
    ..._args: Parameters<BasePlugin['afterToolCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.afterToolCallbackResponse) {
      return this.afterToolCallbackResponse;
    }
    return undefined;
  }

  override async onToolErrorCallback(
    ..._args: Parameters<BasePlugin['onToolErrorCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.onToolErrorCallbackResponse) {
      return this.onToolErrorCallbackResponse;
    }
    return undefined;
  }
}

function randomIdForTestingOnly(): string {
  return (Math.random() * 100).toString();
}

const silentLongRunningTool = new FunctionTool({
  name: 'silentLongRunningTool',
  description: 'long running tool returning nullish',
  parameters: z.object({}),
  execute: async () => null,
  isLongRunning: true,
});

const falsyLongRunningTool = new FunctionTool({
  name: 'falsyLongRunningTool',
  description: 'long running tool returning an empty string',
  parameters: z.object({}),
  execute: async () => '',
  isLongRunning: true,
});

function callFor(tool: BaseTool): FunctionCall {
  return {id: randomIdForTestingOnly(), name: tool.name, args: {}};
}

/**
 * Builds a long-running tool that mutates its tool context and then returns no
 * response.
 */
function createStartJobTool(mutate: (toolContext: Context) => void) {
  return new LongRunningFunctionTool({
    name: 'startJob',
    description: 'starts a background job',
    parameters: z.object({}),
    execute: async (_args, toolContext) => {
      mutate(toolContext!);
      return undefined;
    },
  });
}

describe('handleFunctionCallList', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;
  let functionCall: FunctionCall;
  let toolsDict: Record<string, BaseTool>;
  let warnSpy: MockInstance<typeof logger.warn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // These tests deliberately provoke resolution failures; keep the expected
    // diagnostics out of the suite output.
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
    functionCall = {
      id: randomIdForTestingOnly(),
      name: 'testTool',
      args: {},
    };
    toolsDict = {'testTool': testTool};
  });

  it('should execute tool with no callbacks or plugins', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'tool executed',
    });
  });

  it.each([
    ['empty Error message', new Error('')],
    ['empty string', ''],
    ['zero', 0],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
  ])('preserves a thrown %s as an error response', async (_label, thrown) => {
    const tool = new ThrowingTool(thrown);
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(tool)],
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const response = (event as Event).content!.parts![0].functionResponse!
      .response;
    const expectedError = thrown instanceof Error ? thrown.message : thrown;
    expect(response).toHaveProperty('error', expectedError);
    expect(response).not.toHaveProperty('result');
  });

  it('should wrap array responses into a {results: array} object', async () => {
    const arrayTool = new FunctionTool({
      name: 'arrayTool',
      description: 'returns array',
      parameters: z.object({}),
      execute: async () => {
        return ['item1', 'item2'];
      },
    });

    const arrayFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'arrayTool',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [arrayFunctionCall],
      toolsDict: {'arrayTool': arrayTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      results: ['item1', 'item2'],
    });
  });

  it('should execute beforeToolCallback and return its result', async () => {
    const beforeToolCallback: SingleBeforeToolCallback = async () => {
      return {result: 'beforeToolCallback executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [beforeToolCallback],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'beforeToolCallback executed',
    });
  });

  it('should execute second beforeToolCallback if first returns undefined', async () => {
    const beforeToolCallback1: SingleBeforeToolCallback = async () => {
      return undefined;
    };
    const beforeToolCallback2: SingleBeforeToolCallback = async () => {
      return {result: 'beforeToolCallback2 executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [beforeToolCallback1, beforeToolCallback2],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'beforeToolCallback2 executed',
    });
  });

  it('should execute afterToolCallback and return its result', async () => {
    const afterToolCallback: SingleAfterToolCallback = async () => {
      return {result: 'afterToolCallback executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [afterToolCallback],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'afterToolCallback executed',
    });
  });

  it('should execute second afterToolCallback if first returns undefined', async () => {
    const afterToolCallback1: SingleAfterToolCallback = async () => {
      return undefined;
    };
    const afterToolCallback2: SingleAfterToolCallback = async () => {
      return {result: 'afterToolCallback2 executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [afterToolCallback1, afterToolCallback2],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'afterToolCallback2 executed',
    });
  });

  it('should execute plugin beforeToolCallback and return its result', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.beforeToolCallbackResponse = {
      result: 'plugin beforeToolCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'plugin beforeToolCallback executed',
    });
  });

  it('should execute plugin afterToolCallback and return its result', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.afterToolCallbackResponse = {
      result: 'plugin afterToolCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'plugin afterToolCallback executed',
    });
  });

  it('should call plugin onToolErrorCallback when tool throws', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {
      result: 'onToolErrorCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const errorFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'errorTool',
      args: {},
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [errorFunctionCall],
      toolsDict: {'errorTool': errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'onToolErrorCallback executed',
    });
  });

  it('records a thrown tool error on its execution span', async () => {
    const executionSpan = {
      setAttributes: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    vi.spyOn(tracer, 'startActiveSpan').mockImplementation(((
      _name: string,
      callback: (span: Span) => unknown,
    ) =>
      callback(
        executionSpan as unknown as Span,
      )) as typeof tracer.startActiveSpan);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{...functionCall, name: 'errorTool'}],
      toolsDict: {errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(executionSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('tool error message content'),
      }),
    );
    expect(executionSpan.setAttribute).toHaveBeenCalledWith(
      'error.type',
      'Error',
    );
    expect(executionSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'Error',
    });
    expect(executionSpan.end).toHaveBeenCalledOnce();
    expect(
      executionSpan.recordException.mock.invocationCallOrder[0],
    ).toBeLessThan(executionSpan.end.mock.invocationCallOrder[0]);
    expect(executionSpan.setStatus.mock.invocationCallOrder[0]).toBeLessThan(
      executionSpan.end.mock.invocationCallOrder[0],
    );
  });

  it('records an explicit error type returned by the tool', async () => {
    const executionSpan = {
      setAttributes: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    vi.spyOn(tracer, 'startActiveSpan').mockImplementation(((
      _name: string,
      callback: (span: Span) => unknown,
    ) =>
      callback(
        executionSpan as unknown as Span,
      )) as typeof tracer.startActiveSpan);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{...functionCall, name: 'typedErrorResponseTool'}],
      toolsDict: {typedErrorResponseTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(executionSpan.setAttribute).toHaveBeenCalledWith(
      'error.type',
      'MCP_TOOL_ERROR',
    );
    expect(executionSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'MCP_TOOL_ERROR',
    });
    expect(executionSpan.recordException).not.toHaveBeenCalled();
    expect(executionSpan.end).toHaveBeenCalledOnce();
  });

  it('should return error message when error is thrown during tool execution, when no plugin onToolErrorCallback is provided', async () => {
    const errorFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'errorTool',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [errorFunctionCall],
      toolsDict: {'errorTool': errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      error: "Error in tool 'errorTool': tool error message content",
    });
  });

  it('should route an unregistered tool name through plugin onToolErrorCallback', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {
      error: 'no such tool, try testTool',
    };
    pluginManager.registerPlugin(plugin);
    const onToolErrorCallback = vi.spyOn(plugin, 'onToolErrorCallback');
    const hallucinatedCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'google_search',
      args: {query: 'anything'},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [hallucinatedCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(onToolErrorCallback).toHaveBeenCalledTimes(1);
    const {tool, toolArgs} = onToolErrorCallback.mock.calls[0][0];
    expect(tool.name).toBe('google_search');
    expect(toolArgs).toEqual({query: 'anything'});

    const functionResponse = event!.content!.parts![0].functionResponse!;
    expect(functionResponse.id).toBe(hallucinatedCall.id);
    expect(functionResponse.name).toBe('google_search');
    expect(functionResponse.response).toEqual({
      error: 'no such tool, try testTool',
    });
  });

  it('should answer an unregistered tool name with the resolution error when no plugin handles it', async () => {
    const unresolvableCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'google_search',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [unresolvableCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // The call has to be answered, not left dangling: the request is otherwise
    // identical next iteration, and Gemini rejects an unpaired functionCall.
    const functionResponse = event!.content!.parts![0].functionResponse!;
    expect(functionResponse.id).toBe(unresolvableCall.id);
    expect(functionResponse.name).toBe('google_search');
    const {error} = functionResponse.response as {error: string};
    expect(error).toContain(
      'Function google_search is not found in the toolsDict.',
    );
    // The inventory and the causes are for an operator, not the model: the
    // model already has its declarations and would otherwise pay for the whole
    // toolset on every occurrence.
    expect(error).not.toContain('Callable tools');
    expect(error).not.toContain('Possible causes');
  });

  it('should warn the operator with the inventory and the possible causes', async () => {
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name: 'google_search', args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // Without this the only trace of a misconfigured agent is a string the
    // model sees and the operator never does.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = warnSpy.mock.calls[0][0] as string;
    expect(warning).toContain("Could not resolve tool 'google_search'");
    expect(warning).toContain('call-1');
    expect(warning).toContain('Callable tools: testTool.');
    expect(warning).toContain('Possible causes:');
    // The cause this change tripped over in SleepyTool has to be listed.
    expect(warning).toContain('_getDeclaration()');
    // Built-in tools register themselves now, so they must not be blamed here.
    expect(warning).not.toContain('google_search`');
  });

  it('should not warn when a plugin handles the unresolvable call', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {result: 'handled'};
    pluginManager.registerPlugin(plugin);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name: 'google_search', args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // A plugin that answers these has made them an expected condition; the
    // sibling path for a registered tool that throws is silent too.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should skip the before and after tool callbacks for an unresolvable call', async () => {
    const plugin = new TestPlugin('testPlugin');
    pluginManager.registerPlugin(plugin);
    const beforeToolCallback = vi.spyOn(plugin, 'beforeToolCallback');
    const afterToolCallback = vi.spyOn(plugin, 'afterToolCallback');
    const canonicalAfter = vi.fn().mockResolvedValue(undefined);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name: 'google_search', args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [canonicalAfter],
    });

    // Documented asymmetry with the registered-tool error path, which does run
    // them. Pin it so the doc comment and the code cannot drift apart.
    expect(beforeToolCallback).not.toHaveBeenCalled();
    expect(afterToolCallback).not.toHaveBeenCalled();
    expect(canonicalAfter).not.toHaveBeenCalled();
  });

  it('should hand plugins a placeholder that identifies itself and rethrows', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {result: 'handled'};
    pluginManager.registerPlugin(plugin);
    const onToolErrorCallback = vi.spyOn(plugin, 'onToolErrorCallback');

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name: 'google_search', args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const {tool} = onToolErrorCallback.mock.calls[0][0];
    // A plugin can tell an unresolvable name from a registered tool that threw
    // without matching on the error message.
    expect(isToolNotFound(tool)).toBe(true);
    expect(isToolNotFound(testTool)).toBe(false);
    // Nothing in the framework runs it, but a plugin holding it can, and it
    // must not invent a second, different message.
    await expect(
      tool.runAsync({args: {}, toolContext: {} as Context}),
    ).rejects.toThrow('Function google_search is not found in the toolsDict.');
  });

  // `functionCall.name` is model-supplied and `toolsDict` is a plain object, so
  // an unguarded lookup reaches `Object.prototype`. These names would resolve
  // to a JS builtin, be treated as found, and skip the whole recovery path —
  // `constructor` even answers under the name `Object`, breaking the pairing.
  it.each([
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
  ])('should treat the inherited name %s as unresolvable', async (name) => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name, args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const functionResponse = event!.content!.parts![0].functionResponse!;
    // The response has to name the call, or the pair dangles.
    expect(functionResponse.name).toBe(name);
    expect(functionResponse.id).toBe('call-1');
    expect((functionResponse.response as {error: string}).error).toBe(
      `Function ${name} is not found in the toolsDict.`,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('should answer every call in a batch when one name is unresolvable', async () => {
    const unresolvableId = randomIdForTestingOnly();
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        callFor(testTool),
        {id: unresolvableId, name: 'google_search', args: {}},
        callFor(testTool),
      ],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const responses = event!.content!.parts!.map((p) => p.functionResponse!);
    expect(responses.map((r) => r.name)).toEqual([
      'testTool',
      'google_search',
      'testTool',
    ]);
    expect(responses[0].response).toEqual({result: 'tool executed'});
    expect(responses[2].response).toEqual({result: 'tool executed'});
    // The id is what keeps the pairing balanced, so pin it on the
    // unresolvable slot too — that is the one built off the placeholder.
    expect(responses[1].id).toBe(unresolvableId);
    expect(responses[1].response).toHaveProperty('error');
  });

  it('should pass abortSignal to tool execution', async () => {
    const abortController = new AbortController();
    const signal = abortController.signal;

    const mockTool = new FunctionTool({
      name: 'mockTool',
      description: 'mock tool',
      parameters: z.object({}),
      execute: async () => ({result: 'ok'}),
    });

    const runAsyncSpy = vi.spyOn(mockTool, 'runAsync');
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager,
      abortSignal: signal,
    });

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: '1', name: 'mockTool', args: {}}],
      toolsDict: {'mockTool': mockTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(runAsyncSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {},
        toolContext: expect.objectContaining({
          abortSignal: signal,
        }),
      }),
    );
  });

  it('should still emit an event when a regular tool returns nothing', async () => {
    const nullTool = new FunctionTool({
      name: 'nullTool',
      description: 'tool returning nullish',
      parameters: z.object({}),
      execute: async () => null,
    });
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(nullTool)],
      toolsDict: {'nullTool': nullTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    expect(event?.content?.parts?.[0].functionResponse?.response).toStrictEqual(
      {
        result: null,
      },
    );
  });

  it('should cleanly return null and emit no event when long-running tool returns null or undefined', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(silentLongRunningTool)],
      toolsDict: {silentLongRunningTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).toBeNull();
  });

  it('should emit a response part only for the long-running tool that returned something', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        callFor(silentLongRunningTool),
        callFor(falsyLongRunningTool),
      ],
      toolsDict: {silentLongRunningTool, falsyLongRunningTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event?.content?.parts).toEqual([
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          name: 'falsyLongRunningTool',
          response: {result: ''},
        }),
      }),
    ]);
  });

  it.each([
    [
      'a stateDelta',
      (toolContext: Context) => {
        toolContext.state.set('jobStarted', true);
      },
      {stateDelta: {jobStarted: true}},
    ],
    [
      'skipSummarization',
      (toolContext: Context) => {
        toolContext.actions.skipSummarization = true;
      },
      {skipSummarization: true},
    ],
    [
      'transferToAgent',
      (toolContext: Context) => {
        toolContext.actions.transferToAgent = 'other_agent';
      },
      {transferToAgent: 'other_agent'},
    ],
    [
      'a requested tool confirmation',
      (toolContext: Context) => {
        toolContext.requestConfirmation({hint: 'ok?'});
      },
      {
        requestedToolConfirmations: {
          'lro_1': new ToolConfirmation({hint: 'ok?', confirmed: false}),
        },
      },
    ],
  ])(
    'should emit a content-less event carrying %s',
    async (_label, mutate, expectedActions) => {
      const event = await handleFunctionCallList({
        invocationContext,
        functionCalls: [{id: 'lro_1', name: 'startJob', args: {}}],
        toolsDict: {'startJob': createStartJobTool(mutate)},
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });

      expect(event!.content).toBeUndefined();
      expect(event!.actions).toMatchObject(expectedActions);
      expect(event!.author).toBe('test_agent');
      expect(event!.invocationId).toBe('inv_123');
    },
  );

  it('should merge the actions of a silent long running tool into the batch event', async () => {
    const startJob = createStartJobTool((toolContext) => {
      toolContext.state.set('jobStarted', true);
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(startJob), callFor(testTool)],
      toolsDict: {startJob, testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts!.length).toBe(1);
    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      result: 'tool executed',
    });
    expect(event!.actions.stateDelta).toEqual({jobStarted: true});
  });

  it('should keep the function response of a long running tool that does respond', async () => {
    const startJob = new LongRunningFunctionTool({
      name: 'startJob',
      description: 'starts a background job',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        toolContext!.state.set('jobStarted', true);
        return {status: 'pending'};
      },
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(startJob)],
      toolsDict: {startJob},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      status: 'pending',
    });
    expect(event!.actions.stateDelta).toEqual({jobStarted: true});
  });

  it.each([
    [
      'object return',
      new FunctionTool({
        name: 't',
        description: 'returns object',
        execute: async () => ({ok: true}),
      }),
      {ok: true},
    ],
    [
      'primitive string return',
      new FunctionTool({
        name: 't',
        description: 'returns string',
        execute: async () => 'hello',
      }),
      {result: 'hello'},
    ],
    [
      'array return',
      new FunctionTool({
        name: 't',
        description: 'returns array',
        execute: async () => [1, 2],
      }),
      {results: [1, 2]},
    ],
    [
      'null return',
      new FunctionTool({
        name: 't',
        description: 'returns null',
        execute: async () => null,
      }),
      {result: null},
    ],
    [
      'thrown Error with no onToolErrorCallback override',
      new FunctionTool({
        name: 't',
        description: 'throws Error',
        execute: async () => {
          throw new Error('boom');
        },
      }),
      {error: "Error in tool 't': boom"},
    ],
    [
      'thrown non-Error value',
      new ThrowingTool('raw failure'),
      {error: 'raw failure'},
    ],
  ])(
    'normalizes %s to a Record<string, unknown> before plugin and canonical afterToolCallbacks run',
    async (_label, tool, expectedNormalized) => {
      let pluginSeen: Record<string, unknown> | undefined;
      let canonicalSeen: Record<string, unknown> | undefined;

      class InspectingPlugin extends BasePlugin {
        constructor() {
          super('inspect');
        }
        override async afterToolCallback({
          result,
        }: Parameters<BasePlugin['afterToolCallback']>[0]): Promise<
          Record<string, unknown> | undefined
        > {
          // Verify that `'error' in result` never throws TypeError.
          void ('error' in result);
          pluginSeen = result;
          return undefined;
        }
      }

      pluginManager.registerPlugin(new InspectingPlugin());
      const canonicalAfter: SingleAfterToolCallback = async ({response}) => {
        void ('error' in response);
        canonicalSeen = response;
        return undefined;
      };

      const event = await handleFunctionCallList({
        invocationContext,
        functionCalls: [callFor(tool)],
        toolsDict: {[tool.name]: tool},
        beforeToolCallbacks: [],
        afterToolCallbacks: [canonicalAfter],
      });

      expect(pluginSeen).toStrictEqual(expectedNormalized);
      expect(canonicalSeen).toStrictEqual(expectedNormalized);
      expect(
        event?.content?.parts?.[0].functionResponse?.response,
      ).toStrictEqual(expectedNormalized);
    },
  );

  it('hands afterToolCallback an empty record when a long-running tool returns nullish, while still deferring the event', async () => {
    let pluginSeen: Record<string, unknown> | undefined;
    class InspectingPlugin extends BasePlugin {
      constructor() {
        super('inspect');
      }
      override async afterToolCallback({
        result,
      }: Parameters<BasePlugin['afterToolCallback']>[0]): Promise<
        Record<string, unknown> | undefined
      > {
        expect('error' in result).toBe(false);
        pluginSeen = result;
        return undefined;
      }
    }
    pluginManager.registerPlugin(new InspectingPlugin());

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(silentLongRunningTool)],
      toolsDict: {silentLongRunningTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(pluginSeen).toStrictEqual({});
    expect(event).toBeNull();
  });

  it('allows afterToolCallback to override an unhandled tool error response', async () => {
    const afterToolCallback: SingleAfterToolCallback = async ({response}) => {
      if ('error' in response) {
        return {recoveredFrom: response['error']};
      }
      return undefined;
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(errorTool)],
      toolsDict: {errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [afterToolCallback],
    });

    expect(event?.content?.parts?.[0].functionResponse?.response).toEqual({
      recoveredFrom: "Error in tool 'errorTool': tool error message content",
    });
  });
});

describe('generateAuthEvent', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;

  beforeEach(() => {
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
  });

  it('should return undefined if no requestedAuthConfigs', () => {
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeUndefined();
  });

  it('should return undefined if requestedAuthConfigs is empty', () => {
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeUndefined();
  });

  it('should return auth event if requestedAuthConfigs is present', () => {
    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedAuthConfigs: {
          // @ts-expect-error - testing string assignments
          'call_1': 'auth_config_1',
          // @ts-expect-error - testing string assignments
          'call_2': 'auth_config_2',
        },
      }),
      content: {role: 'model', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeDefined();
    expect(event!.invocationId).toBe('inv_123');
    expect(event!.author).toBe('test_agent');
    expect(event!.content!.parts!.length).toBe(2);

    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) => p.functionCall?.args?.['function_call_id'] === 'call_1',
    );
    expect(call1).toBeDefined();
    expect(call1!.functionCall!.name).toBe('adk_request_credential');
    expect(call1!.functionCall!.args!['auth_config']).toBe('auth_config_1');

    const call2 = parts.find(
      (p) => p.functionCall?.args?.['function_call_id'] === 'call_2',
    );
    expect(call2).toBeDefined();
    expect(call2!.functionCall!.name).toBe('adk_request_credential');
    expect(call2!.functionCall!.args!['auth_config']).toBe('auth_config_2');
  });

  it('should default the role to user for a content-less event', () => {
    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedAuthConfigs: {
          'call_1': {
            authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
            credentialKey: 'test-credential-key',
          },
        },
      }),
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);

    expect(event!.content!.role).toBe('user');
    expect(event!.content!.parts!.length).toBe(1);
    expect(event!.content!.parts![0].functionCall!.name).toBe(
      'adk_request_credential',
    );
  });
});

describe('generateRequestConfirmationEvent', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;

  beforeEach(() => {
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
  });

  it('should return undefined if no requestedToolConfirmations', () => {
    const functionCallEvent = createEvent({content: {role: 'user', parts: []}});
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });
    expect(event).toBeUndefined();
  });

  it('should return undefined if requestedToolConfirmations is empty', () => {
    const functionCallEvent = createEvent({content: {role: 'user', parts: []}});
    const functionResponseEvent = createEvent({
      actions: createEventActions({requestedToolConfirmations: {}}),
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });
    expect(event).toBeUndefined();
  });

  it('should return confirmation event if requestedToolConfirmations is present', () => {
    const functionCallEvent = createEvent({
      content: {
        role: 'user',
        parts: [
          {
            functionCall: {
              name: 'tool_1',
              args: {arg: 'val1'},
              id: 'call_1',
            },
          },
          {
            functionCall: {
              name: 'tool_2',
              args: {arg: 'val2'},
              id: 'call_2',
            },
          },
        ],
      },
    });

    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          'call_1': new ToolConfirmation({
            hint: 'confirm tool 1',
            confirmed: false,
          }),
          'call_2': new ToolConfirmation({
            hint: 'confirm tool 2',
            confirmed: false,
          }),
        },
      }),
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event).toBeDefined();
    expect(event!.invocationId).toBe('inv_123');
    expect(event!.author).toBe('test_agent');
    expect(event!.content!.parts!.length).toBe(2);

    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_1',
    );
    expect(call1).toBeDefined();
    expect(call1!.functionCall!.name).toBe('adk_request_confirmation');
    expect(call1!.functionCall!.args!['toolConfirmation']).toEqual(
      new ToolConfirmation({
        hint: 'confirm tool 1',
        confirmed: false,
      }),
    );

    const call2 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_2',
    );
    expect(call2).toBeDefined();
    expect(call2!.functionCall!.name).toBe('adk_request_confirmation');
    expect(call2!.functionCall!.args!['toolConfirmation']).toEqual(
      new ToolConfirmation({
        hint: 'confirm tool 2',
        confirmed: false,
      }),
    );
  });

  it('should skip confirmation if original function call is not found', () => {
    const functionCallEvent = createEvent({
      content: {
        role: 'user',
        parts: [
          {
            functionCall: {
              name: 'tool_1',
              args: {arg: 'val1'},
              id: 'call_1',
            },
          },
        ],
      },
    });

    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          'call_1': new ToolConfirmation({
            hint: 'confirm tool 1',
            confirmed: false,
          }),
          'call_missing': new ToolConfirmation({
            hint: 'confirm tool missing',
            confirmed: false,
          }),
        },
      }),
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event).toBeDefined();
    expect(event!.content!.parts!.length).toBe(1);
    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_1',
    );
    expect(call1).toBeDefined();
  });

  it('should default the role to user for a content-less event', () => {
    const functionCallEvent = createEvent({
      content: {
        role: 'user',
        parts: [{functionCall: {name: 'tool_1', args: {}, id: 'call_1'}}],
      },
    });
    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          'call_1': new ToolConfirmation({hint: 'ok?', confirmed: false}),
        },
      }),
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event!.content!.role).toBe('user');
    expect(event!.content!.parts!.length).toBe(1);
    expect(event!.content!.parts![0].functionCall!.name).toBe(
      'adk_request_confirmation',
    );
  });
});

describe('generateClientFunctionCallId', () => {
  it('should generate a valid ID with prefix', () => {
    const id = generateClientFunctionCallId();
    expect(id).toMatch(/^adk-/);
  });
});

describe('getLongRunningFunctionCalls', () => {
  it('should return IDs of long running function calls', () => {
    const functionCalls = [
      {name: 'longTool', id: 'call-1'},
      {name: 'shortTool', id: 'call-2'},
    ];
    const toolsDict: Record<string, BaseTool> = {
      'longTool': new FunctionTool({
        name: 'longTool',
        description: 'long',
        execute: async () => ({}),
        isLongRunning: true,
      }),
      'shortTool': new FunctionTool({
        name: 'shortTool',
        description: 'short',
        execute: async () => ({}),
        isLongRunning: false,
      }),
    };
    const result = getLongRunningFunctionCalls(functionCalls, toolsDict);
    expect(result.has('call-1')).toBe(true);
    expect(result.has('call-2')).toBe(false);
  });
});

describe('mergeParallelFunctionResponseEvents', () => {
  it('should merge multiple events into one', () => {
    const event1 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool1', response: {result: 1}, id: 'id1'}},
        ],
      },
    });
    const event2 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool2', response: {result: 2}, id: 'id2'}},
        ],
      },
    });
    const merged = mergeParallelFunctionResponseEvents([event1, event2]);
    expect(merged.content!.parts!.length).toBe(2);
    expect(merged.content!.parts![0].functionResponse!.name).toBe('tool1');
    expect(merged.content!.parts![1].functionResponse!.name).toBe('tool2');
  });

  it('should throw if no events provided', () => {
    expect(() => mergeParallelFunctionResponseEvents([])).toThrow(
      'No function response events provided.',
    );
  });

  it('should return the same event if only one provided', () => {
    const event = createEvent();
    const merged = mergeParallelFunctionResponseEvents([event]);
    expect(merged).toBe(event);
  });
});

describe('findEventByFunctionCallId', () => {
  it('should find event with matching functionCall id', () => {
    const event1 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: 'tool1', args: {}}}],
      },
    });
    const event2 = createEvent({
      invocationId: 'inv-2',
      author: 'agent-2',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-2', name: 'tool2', args: {}}}],
      },
    });
    expect(findEventByFunctionCallId([event1, event2], 'call-1')).toBe(event1);
    expect(findEventByFunctionCallId([event1, event2], 'call-2')).toBe(event2);
  });

  it('should return undefined if no matching functionCall id found or events empty', () => {
    const event1 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: 'tool1', args: {}}}],
      },
    });
    expect(findEventByFunctionCallId([event1], 'non-existent')).toBeUndefined();
    expect(findEventByFunctionCallId([], 'call-1')).toBeUndefined();
  });
});

describe('findMatchingFunctionCall', () => {
  it('should find matching function call for last event function response', () => {
    const callEvent = createEvent({
      invocationId: 'inv-1',
      author: 'sub-agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'lro-id-123', name: 'longRunningOp', args: {}}},
        ],
      },
    });
    const responseEvent = createEvent({
      invocationId: 'inv-2',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'lro-id-123',
              name: 'longRunningOp',
              response: {status: 'DONE'},
            },
          },
        ],
      },
    });
    expect(findMatchingFunctionCall([callEvent, responseEvent])).toBe(
      callEvent,
    );
  });

  it('should return undefined if last event is not function response or events empty', () => {
    const callEvent = createEvent({
      invocationId: 'inv-1',
      author: 'sub-agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'lro-id-123', name: 'longRunningOp', args: {}}},
        ],
      },
    });
    expect(findMatchingFunctionCall([callEvent])).toBeUndefined();
    expect(findMatchingFunctionCall([])).toBeUndefined();
  });

  it('checks every function response in the last event, not just the first', () => {
    // response 0 has no matching call (a stale or unmatched id); response 1
    // is the one that actually resolves. The pre-fix code read only
    // functionResponses[0] and would have returned undefined here even
    // though the event does answer a real, resumable call -- this is the
    // shape "check every response" exists for, and the only test in this
    // file that fails without the fix for that specific reason (the other
    // two-response case below happens to pass either way, since it never
    // puts the resolving response anywhere but last).
    const callB = createEvent({
      invocationId: 'inv-b',
      author: 'agent_b',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc-b', name: 'tool_b', args: {}}}],
      },
    });
    const mixedResponses = createEvent({
      invocationId: 'inv-new',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-does-not-exist',
              name: 'tool_a',
              response: {result: 'a done'},
            },
          },
          {
            functionResponse: {
              id: 'fc-b',
              name: 'tool_b',
              response: {result: 'b done'},
            },
          },
        ],
      },
    });

    expect(findMatchingFunctionCall([callB, mixedResponses])).toBe(callB);
  });

  it('resolves multiple responses from the same agent without conflict', () => {
    // Two responses in one event answering two calls from the SAME agent
    // (parallel tool calls within a single invocation) must still resolve
    // normally -- only responses that disagree on author are a conflict.
    const callEvent = createEvent({
      invocationId: 'inv-1',
      author: 'agent_a',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'fc-1', name: 'tool_a', args: {}}},
          {functionCall: {id: 'fc-2', name: 'tool_b', args: {}}},
        ],
      },
    });
    const bothResponses = createEvent({
      invocationId: 'inv-new',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'tool_a',
              response: {result: 'done'},
            },
          },
          {
            functionResponse: {
              id: 'fc-2',
              name: 'tool_b',
              response: {result: 'done'},
            },
          },
        ],
      },
    });

    expect(findMatchingFunctionCall([callEvent, bothResponses])).toBe(
      callEvent,
    );
  });

  it('resolves to the last match by iteration order when responses conflict, without throwing', () => {
    // findMatchingFunctionCall is a pure lookup: it does not throw on a
    // conflict (getConflictingFunctionResponseAuthors, tested below, is
    // what surfaces that). This pins the documented last-wins behavior
    // for that case, which is a change from the pre-fix code's effective
    // first-wins behavior (it only ever read functionResponses[0]).
    const callA = createEvent({
      invocationId: 'inv-a',
      author: 'agent_a',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc-a', name: 'tool_a', args: {}}}],
      },
    });
    const callB = createEvent({
      invocationId: 'inv-b',
      author: 'agent_b',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc-b', name: 'tool_b', args: {}}}],
      },
    });
    const bothResponses = createEvent({
      invocationId: 'inv-new',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-a',
              name: 'tool_a',
              response: {result: 'a done'},
            },
          },
          {
            functionResponse: {
              id: 'fc-b',
              name: 'tool_b',
              response: {result: 'b done'},
            },
          },
        ],
      },
    });

    expect(findMatchingFunctionCall([callA, callB, bothResponses])).toBe(callB);
  });
});

describe('getConflictingFunctionResponseAuthors', () => {
  it('returns the conflicting author pair when responses resolve to more than one agent', () => {
    const callA = createEvent({
      invocationId: 'inv-a',
      author: 'agent_a',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc-a', name: 'tool_a', args: {}}}],
      },
    });
    const callB = createEvent({
      invocationId: 'inv-b',
      author: 'agent_b',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc-b', name: 'tool_b', args: {}}}],
      },
    });
    const bothResponses = createEvent({
      invocationId: 'inv-new',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-a',
              name: 'tool_a',
              response: {result: 'a done'},
            },
          },
          {
            functionResponse: {
              id: 'fc-b',
              name: 'tool_b',
              response: {result: 'b done'},
            },
          },
        ],
      },
    });

    expect(
      getConflictingFunctionResponseAuthors([callA, callB, bothResponses]),
    ).toEqual(['agent_a', 'agent_b']);
  });

  it('returns undefined when responses all resolve to the same agent', () => {
    const callEvent = createEvent({
      invocationId: 'inv-1',
      author: 'agent_a',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'fc-1', name: 'tool_a', args: {}}},
          {functionCall: {id: 'fc-2', name: 'tool_b', args: {}}},
        ],
      },
    });
    const bothResponses = createEvent({
      invocationId: 'inv-new',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'tool_a',
              response: {result: 'done'},
            },
          },
          {
            functionResponse: {
              id: 'fc-2',
              name: 'tool_b',
              response: {result: 'done'},
            },
          },
        ],
      },
    });

    expect(
      getConflictingFunctionResponseAuthors([callEvent, bothResponses]),
    ).toBeUndefined();
  });

  it('returns undefined when there is nothing to resolve', () => {
    const callEvent = createEvent({
      invocationId: 'inv-1',
      author: 'sub-agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'lro-id-123', name: 'longRunningOp', args: {}}},
        ],
      },
    });
    expect(getConflictingFunctionResponseAuthors([callEvent])).toBeUndefined();
    expect(getConflictingFunctionResponseAuthors([])).toBeUndefined();
  });
});

describe('handleFunctionCallsLive and processFunctionLiveHelper', () => {
  function createLiveInvocationContext(): InvocationContext {
    const agent = new LlmAgent({
      name: 'live_test_agent',
      model: 'gemini-2.0-flash',
    });
    return new InvocationContext({
      invocationId: 'inv-live-1',
      agent,
      session: createSession({
        id: 'sess-live-1',
        userId: 'user-live-1',
        appName: 'app-live-1',
      }),
      liveRequestQueue: new LiveRequestQueue(),
      pluginManager: new PluginManager(),
    });
  }

  it('executes a regular function tool in live mode and merges parallel responses', async () => {
    const ctx = createLiveInvocationContext();
    const sumTool = new FunctionTool({
      name: 'sumTool',
      description: 'adds two numbers',
      parameters: z.object({a: z.number(), b: z.number()}),
      execute: async ({a, b}) => ({sum: a + b}),
    });
    const callEvent = createEvent({
      invocationId: ctx.invocationId,
      author: 'live_test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-sum-1',
              name: 'sumTool',
              args: {a: 2, b: 5},
            },
          },
          {
            functionCall: {
              id: 'fc-test-1',
              name: 'testTool',
              args: {},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: callEvent,
      toolsDict: {sumTool, testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(responseEvent).not.toBeNull();
    expect(responseEvent?.content?.parts).toEqual([
      {
        functionResponse: {
          id: 'fc-sum-1',
          name: 'sumTool',
          response: {sum: 7},
        },
      },
      {
        functionResponse: {
          id: 'fc-test-1',
          name: 'testTool',
          response: {result: 'tool executed'},
        },
      },
    ]);
  });

  it('applies beforeToolCallbacks and afterToolCallbacks in handleFunctionCallsLive', async () => {
    const ctx = createLiveInvocationContext();
    const beforeCb: SingleBeforeToolCallback = async ({args}) => {
      if (args['shortCircuit']) {
        return {intercepted: 'before'};
      }
      return undefined;
    };
    const afterCb: SingleAfterToolCallback = async ({response}) => {
      return {...(response as Record<string, unknown>), afterTag: true};
    };
    const callEvent = createEvent({
      invocationId: ctx.invocationId,
      author: 'live_test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-cb-1',
              name: 'testTool',
              args: {shortCircuit: true},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: callEvent,
      toolsDict: {testTool},
      beforeToolCallbacks: [beforeCb],
      afterToolCallbacks: [afterCb],
    });

    expect(responseEvent?.content?.parts).toEqual([
      {
        functionResponse: {
          id: 'fc-cb-1',
          name: 'testTool',
          response: {intercepted: 'before', afterTag: true},
        },
      },
    ]);
  });

  it('starts a background Task for an async-generator streaming tool, preserves an existing stream, and forwards yielded values to liveRequestQueue', async () => {
    const ctx = createLiveInvocationContext();
    const existingStream = new LiveRequestQueue();
    ctx.activeStreamingTools = {
      monitorPrice: new ActiveStreamingTool({stream: existingStream}),
    };
    const streamTool = new FunctionTool({
      name: 'monitorPrice',
      description: 'streams price updates',
      parameters: z.object({symbol: z.string()}),
      execute: async function* ({symbol}) {
        yield `${symbol}:101`;
        yield `${symbol}:102`;
      },
    });
    const callEvent = createEvent({
      invocationId: ctx.invocationId,
      author: 'live_test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-stream-1',
              name: 'monitorPrice',
              args: {symbol: 'GOOG'},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: callEvent,
      toolsDict: {monitorPrice: streamTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(responseEvent?.content?.parts).toEqual([
      {
        functionResponse: {
          id: 'fc-stream-1',
          name: 'monitorPrice',
          response: {
            status:
              'The function is running asynchronously and the results are pending.',
          },
        },
      },
    ]);
    expect(ctx.activeStreamingTools?.['monitorPrice']?.stream).toBe(
      existingStream,
    );
    expect(ctx.activeStreamingTools?.['monitorPrice']?.task).toBeDefined();
    await ctx.activeStreamingTools?.['monitorPrice']?.task?.promise;

    const firstQueued = await ctx.liveRequestQueue?.get();
    const secondQueued = await ctx.liveRequestQueue?.get();
    expect(firstQueued?.content).toEqual({
      role: 'user',
      parts: [{text: 'Function monitorPrice returned: GOOG:101'}],
    });
    expect(secondQueued?.content).toEqual({
      role: 'user',
      parts: [{text: 'Function monitorPrice returned: GOOG:102'}],
    });
  });

  it('cancels an active streaming tool when stop_streaming is called', async () => {
    const ctx = createLiveInvocationContext();
    let releaseStream: (() => void) | undefined;
    const streamTool = new FunctionTool({
      name: 'tickerStream',
      description: 'streams ticker indefinitely until cancelled',
      parameters: z.object({}),
      execute: async function* () {
        yield 'tick-1';
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        yield 'tick-2';
      },
    });
    const stopStreamingTool = new FunctionTool({
      name: 'stop_streaming',
      description: 'stops a streaming tool',
      parameters: z.object({function_name: z.string()}),
      execute: async () => ({}),
    });

    await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: createEvent({
        invocationId: ctx.invocationId,
        author: 'live_test_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-start-1',
                name: 'tickerStream',
                args: {},
              },
            },
          ],
        },
      }),
      toolsDict: {tickerStream: streamTool, stop_streaming: stopStreamingTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const firstTick = await ctx.liveRequestQueue?.get();
    expect(firstTick?.content?.parts?.[0]?.text).toBe(
      'Function tickerStream returned: tick-1',
    );
    expect(ctx.activeStreamingTools?.['tickerStream']?.task?.done()).toBe(
      false,
    );

    const stopResponseEvent = await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: createEvent({
        invocationId: ctx.invocationId,
        author: 'live_test_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-stop-1',
                name: 'stop_streaming',
                args: {function_name: 'tickerStream'},
              },
            },
          ],
        },
      }),
      toolsDict: {tickerStream: streamTool, stop_streaming: stopStreamingTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    releaseStream?.();
    expect(stopResponseEvent?.content?.parts).toEqual([
      {
        functionResponse: {
          id: 'fc-stop-1',
          name: 'stop_streaming',
          response: {
            status: 'Successfully stopped streaming function tickerStream',
          },
        },
      },
    ]);
    expect(ctx.activeStreamingTools?.['tickerStream']?.task).toBeUndefined();
  });

  it('returns not-found status when stop_streaming targets an inactive or unknown tool', async () => {
    const ctx = createLiveInvocationContext();
    const stopStreamingTool = new FunctionTool({
      name: 'stop_streaming',
      description: 'stops a streaming tool',
      parameters: z.object({function_name: z.string()}),
      execute: async () => ({}),
    });

    const result = await processFunctionLiveHelper({
      tool: stopStreamingTool,
      toolContext: new Context({invocationContext: ctx}),
      functionCall: {
        id: 'fc-stop-missing',
        name: 'stop_streaming',
        args: {function_name: 'nonExistentStream'},
      },
      functionArgs: {function_name: 'nonExistentStream'},
      invocationContext: ctx,
    });

    expect(result).toEqual({
      status: 'No active streaming function named nonExistentStream found',
    });
  });

  it('logs a warning and reports not-cancelled status when a streaming task does not finish before timeout', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const ctx = createLiveInvocationContext();
      let resolveStuckTask: (() => void) | undefined;
      const stuckTask = new Task<void>(
        () =>
          new Promise<void>((resolve) => {
            resolveStuckTask = resolve;
          }),
      );
      ctx.activeStreamingTools = {
        stuckStream: new ActiveStreamingTool({task: stuckTask}),
      };
      const stopStreamingTool = new FunctionTool({
        name: 'stop_streaming',
        description: 'stops a streaming tool',
        parameters: z.object({function_name: z.string()}),
        execute: async () => ({}),
      });

      const pendingResult = processFunctionLiveHelper({
        tool: stopStreamingTool,
        toolContext: new Context({invocationContext: ctx}),
        functionCall: {
          id: 'fc-stop-stuck',
          name: 'stop_streaming',
          args: {function_name: 'stuckStream'},
        },
        functionArgs: {function_name: 'stuckStream'},
        invocationContext: ctx,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await pendingResult;

      expect(result).toEqual({
        status: 'The task is not cancelled yet for stuckStream.',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        'The task for stuckStream is not cancelled yet.',
      );
      resolveStuckTask?.();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
