/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ActiveStreamingTool,
  AfterToolCallback,
  AgentTool,
  AUTH_PREPROCESSOR,
  AuthConfig,
  AuthCredentialTypes,
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  BaseTool,
  BaseToolset,
  BeforeToolCallback,
  ComputerUseTool,
  Context,
  createEvent,
  createEventActions,
  createSession,
  Event,
  functionsExportedForTestingOnly,
  FunctionTool,
  getFunctionCalls,
  getFunctionResponses,
  InMemorySessionService,
  InvocationContext,
  isToolNotFound,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  PluginManager,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  Runner,
  Session,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
  ToolConfirmation,
} from '@google/adk';
import {Content, FunctionCall, FunctionResponse, Type} from '@google/genai';
import {context, SpanStatusCode, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type {MockInstance} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  findEventByFunctionCallId,
  findMatchingFunctionCall,
  generateClientFunctionCallId,
  getConflictingFunctionResponseAuthors,
  getLongRunningFunctionCalls,
  handleFunctionCallsAsync,
  mergeParallelFunctionResponseEvents,
} from '../../src/agents/functions.js';
import {
  getDeltaWriteStamp,
  getStateWriteStamp,
} from '../../src/sessions/state_write_order.js';
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
  let spanExporter: InMemorySpanExporter;
  let spanContextManager: AsyncLocalStorageContextManager;
  let spanProvider: BasicTracerProvider;
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;
  let functionCall: FunctionCall;
  let toolsDict: Record<string, BaseTool>;
  let warnSpy: MockInstance<typeof logger.warn>;

  afterEach(async () => {
    await spanProvider.shutdown();
    trace.disable();
    context.disable();
    spanContextManager.disable();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    trace.disable();
    context.disable();
    spanExporter = new InMemorySpanExporter();
    spanContextManager = new AsyncLocalStorageContextManager().enable();
    spanProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    context.setGlobalContextManager(spanContextManager);
    trace.setGlobalTracerProvider(spanProvider);
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
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{...functionCall, name: 'errorTool'}],
      toolsDict: {errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const spans = spanExporter
      .getFinishedSpans()
      .filter((s) => s.name === 'execute_tool errorTool');
    expect(spans).toHaveLength(1);
    const executionSpan = spans[0];
    expect(executionSpan.events).toEqual([
      expect.objectContaining({
        name: 'exception',
        attributes: expect.objectContaining({
          'exception.message': expect.stringContaining(
            'tool error message content',
          ),
        }),
      }),
    ]);
    expect(executionSpan.attributes['error.type']).toBe('Error');
    expect(executionSpan.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'Error',
    });
    expect(executionSpan.ended).toBe(true);
  });

  it('records an explicit error type returned by the tool', async () => {
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{...functionCall, name: 'typedErrorResponseTool'}],
      toolsDict: {typedErrorResponseTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const spans = spanExporter
      .getFinishedSpans()
      .filter((s) => s.name === 'execute_tool typedErrorResponseTool');
    expect(spans).toHaveLength(1);
    const executionSpan = spans[0];
    expect(executionSpan.attributes['error.type']).toBe('MCP_TOOL_ERROR');
    expect(executionSpan.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'MCP_TOOL_ERROR',
    });
    expect(executionSpan.events).toEqual([]);
    expect(executionSpan.ended).toBe(true);
  });

  it('records name, arguments, and result on a single execute_tool span per call when content capture is SPAN_ONLY', async () => {
    const simpleFn = new FunctionTool({
      name: 'simple_fn',
      description: 'simple function',
      parameters: z.object({a: z.number(), b: z.number()}),
      execute: async () => ({result: 'test'}),
    });
    const spanOnlyContext = new InvocationContext({
      invocationId: 'inv_span_only',
      session: {} as Session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager,
      runConfig: {
        telemetry: {
          captureMessageContent: 'SPAN_ONLY',
        },
      },
    });

    await handleFunctionCallList({
      invocationContext: spanOnlyContext,
      functionCalls: [{id: 'call-1', name: 'simple_fn', args: {a: 1, b: 2}}],
      toolsDict: {simple_fn: simpleFn},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    await handleFunctionCallList({
      invocationContext: spanOnlyContext,
      functionCalls: [{id: 'call-2', name: 'simple_fn', args: {a: 1, b: 2}}],
      toolsDict: {simple_fn: simpleFn},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const spans = spanExporter
      .getFinishedSpans()
      .filter((s) => s.name === 'execute_tool simple_fn');
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.attributes['gen_ai.tool.name']).toBe('simple_fn');
      expect(span.attributes['gen_ai.tool.call.arguments']).toBe(
        JSON.stringify({a: 1, b: 2}),
      );
      expect(span.attributes['gen_ai.tool.call.result']).toBe(
        JSON.stringify({result: 'test'}),
      );
    }
  });

  it('preserves unescaped non-ASCII characters in tool call arguments', async () => {
    const unicodeTool = new FunctionTool({
      name: 'unicodeTool',
      description: 'handles non-ASCII input',
      parameters: z.object({greeting: z.string()}),
      execute: async ({greeting}) => ({echo: greeting}),
    });
    const spanOnlyContext = new InvocationContext({
      invocationId: 'inv_unicode',
      session: {} as Session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager,
      runConfig: {
        telemetry: {
          captureMessageContent: 'SPAN_ONLY',
        },
      },
    });

    await handleFunctionCallList({
      invocationContext: spanOnlyContext,
      functionCalls: [
        {
          id: 'call-unicode',
          name: 'unicodeTool',
          args: {greeting: 'こんにちは世界 🌍 café'},
        },
      ],
      toolsDict: {unicodeTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const spans = spanExporter
      .getFinishedSpans()
      .filter((s) => s.name === 'execute_tool unicodeTool');
    expect(spans).toHaveLength(1);
    const serializedArgs = String(
      spans[0].attributes['gen_ai.tool.call.arguments'],
    );
    expect(serializedArgs).toContain('こんにちは世界 🌍 café');
    expect(serializedArgs).not.toContain('\\u3053');
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

  it('executes an AgentTool in handleFunctionCallsLive and returns the sub-agent output', async () => {
    class StubSubAgent extends BaseAgent {
      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        const lastMessage =
          context.session.events.at(-1)?.content?.parts?.[0]?.text ?? '';
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {
            role: 'model',
            parts: [{text: `sub-agent answer: ${lastMessage}`}],
          },
          actions: createEventActions({
            stateDelta: {subAgentRan: true},
          }),
        });
      }

      protected override async *runLiveImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}
    }

    const ctx = createLiveInvocationContext();
    const subAgent = new StubSubAgent({
      name: 'sub_agent_tool',
      description: 'delegates to a sub-agent',
    });
    const agentTool = new AgentTool({agent: subAgent});
    const callEvent = createEvent({
      invocationId: ctx.invocationId,
      author: 'live_test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-agent-tool-1',
              name: 'sub_agent_tool',
              args: {request: 'check status'},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: callEvent,
      toolsDict: {sub_agent_tool: agentTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(responseEvent).not.toBeNull();
    expect(responseEvent?.content?.parts).toEqual([
      {
        functionResponse: {
          id: 'fc-agent-tool-1',
          name: 'sub_agent_tool',
          response: {result: 'sub-agent answer: check status'},
        },
      },
    ]);
    expect(responseEvent?.actions?.stateDelta).toEqual({
      subAgentRan: true,
    });
  });

  interface LiveCallbackChainSpec {
    name: string;
    callbacks: Array<{response: unknown; isAsync: boolean}>;
    expectedResponse: Record<string, unknown>;
    expectedCalls: number[];
    expectToolExecuted: boolean;
  }

  const LIVE_CALLBACK_CHAIN_CASES: LiveCallbackChainSpec[] = [
    {
      name: 'when single sync callback returns undefined',
      callbacks: [{response: undefined, isAsync: false}],
      expectedResponse: {initial: 'response'},
      expectedCalls: [1],
      expectToolExecuted: true,
    },
    {
      name: 'when single async callback returns undefined',
      callbacks: [{response: undefined, isAsync: true}],
      expectedResponse: {initial: 'response'},
      expectedCalls: [1],
      expectToolExecuted: true,
    },
    {
      name: 'when first sync callback returns an empty object',
      callbacks: [
        {response: {}, isAsync: false},
        {response: {second: 'callback'}, isAsync: true},
      ],
      expectedResponse: {},
      expectedCalls: [1, 0],
      expectToolExecuted: false,
    },
    {
      name: 'when first async callback returns an empty object',
      callbacks: [
        {response: {}, isAsync: true},
        {response: {second: 'callback'}, isAsync: false},
      ],
      expectedResponse: {},
      expectedCalls: [1, 0],
      expectToolExecuted: false,
    },
    {
      name: 'when first sync callback returns falsy zero',
      callbacks: [
        {response: 0, isAsync: false},
        {response: {second: 'callback'}, isAsync: false},
      ],
      expectedResponse: {result: 0},
      expectedCalls: [1, 0],
      expectToolExecuted: false,
    },
    {
      name: 'when first returns undefined and second async returns a payload',
      callbacks: [
        {response: undefined, isAsync: false},
        {response: {second: 'callback'}, isAsync: true},
        {response: {third: 'callback'}, isAsync: false},
      ],
      expectedResponse: {second: 'callback'},
      expectedCalls: [1, 1, 0],
      expectToolExecuted: false,
    },
    {
      name: 'when mixed sync and async callbacks all return undefined',
      callbacks: [
        {response: undefined, isAsync: false},
        {response: undefined, isAsync: true},
      ],
      expectedResponse: {initial: 'response'},
      expectedCalls: [1, 1],
      expectToolExecuted: true,
    },
  ];

  it.each(LIVE_CALLBACK_CHAIN_CASES)(
    'executes live beforeToolCallbacks chain ($name)',
    async ({
      callbacks,
      expectedResponse,
      expectedCalls,
      expectToolExecuted,
    }) => {
      const ctx = createLiveInvocationContext();
      let toolCalls = 0;
      const simpleTool = new FunctionTool({
        name: 'simpleTool',
        description: 'returns an initial object',
        parameters: z.object({}),
        execute: async () => {
          toolCalls += 1;
          return {initial: 'response'};
        },
      });
      const spies = callbacks.map(({response, isAsync}) =>
        vi.fn<SingleBeforeToolCallback>(() =>
          isAsync
            ? Promise.resolve(response as Record<string, unknown> | undefined)
            : (response as Record<string, unknown> | undefined),
        ),
      );
      const callEvent = createEvent({
        invocationId: ctx.invocationId,
        author: 'liveTestAgent',
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'fc-chain-b', name: 'simpleTool', args: {}}},
          ],
        },
      });

      const responseEvent = await handleFunctionCallsLive({
        invocationContext: ctx,
        functionCallEvent: callEvent,
        toolsDict: {simpleTool},
        beforeToolCallbacks: spies,
        afterToolCallbacks: [],
      });

      expect(
        responseEvent?.content?.parts?.[0]?.functionResponse?.response,
      ).toEqual(expectedResponse);
      expect(toolCalls).toBe(expectToolExecuted ? 1 : 0);
      spies.forEach((spy, index) => {
        expect(spy).toHaveBeenCalledTimes(expectedCalls[index]);
      });
    },
  );

  it.each(LIVE_CALLBACK_CHAIN_CASES)(
    'executes live afterToolCallbacks chain ($name)',
    async ({callbacks, expectedResponse, expectedCalls}) => {
      const ctx = createLiveInvocationContext();
      const simpleTool = new FunctionTool({
        name: 'simpleTool',
        description: 'returns an initial object',
        parameters: z.object({}),
        execute: async () => ({initial: 'response'}),
      });
      const spies = callbacks.map(({response, isAsync}) =>
        vi.fn<SingleAfterToolCallback>(() =>
          isAsync
            ? Promise.resolve(response as Record<string, unknown> | undefined)
            : (response as Record<string, unknown> | undefined),
        ),
      );
      const callEvent = createEvent({
        invocationId: ctx.invocationId,
        author: 'liveTestAgent',
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'fc-chain-a', name: 'simpleTool', args: {}}},
          ],
        },
      });

      const responseEvent = await handleFunctionCallsLive({
        invocationContext: ctx,
        functionCallEvent: callEvent,
        toolsDict: {simpleTool},
        beforeToolCallbacks: [],
        afterToolCallbacks: spies,
      });

      expect(
        responseEvent?.content?.parts?.[0]?.functionResponse?.response,
      ).toEqual(expectedResponse);
      spies.forEach((spy, index) => {
        expect(spy).toHaveBeenCalledTimes(expectedCalls[index]);
      });
    },
  );

  it('runs beforeToolCallbacks and afterToolCallbacks together when before returns undefined in live mode', async () => {
    const ctx = createLiveInvocationContext();
    let beforeCalled = false;
    const echoArgsTool = new FunctionTool({
      name: 'echoArgsTool',
      description: 'returns input args and initial tag',
      parameters: z.object({modifiedByBefore: z.boolean().optional()}),
      execute: async (args) => ({initial: 'response', seenArgs: args}),
    });
    const beforeCb: SingleBeforeToolCallback = ({args}) => {
      beforeCalled = true;
      args['modifiedByBefore'] = true;
      return undefined;
    };
    const afterCb: SingleAfterToolCallback = ({response}) => {
      return {...response, modifiedByAfter: true};
    };
    const callEvent = createEvent({
      invocationId: ctx.invocationId,
      author: 'liveTestAgent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'fc-mixed', name: 'echoArgsTool', args: {}}},
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: callEvent,
      toolsDict: {echoArgsTool},
      beforeToolCallbacks: [beforeCb],
      afterToolCallbacks: [afterCb],
    });

    expect(beforeCalled).toBe(true);
    expect(
      responseEvent?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      initial: 'response',
      seenArgs: {modifiedByBefore: true},
      modifiedByAfter: true,
    });
  });

  it('prioritizes plugin tool callbacks over canonical callbacks in handleFunctionCallsLive', async () => {
    const ctx = createLiveInvocationContext();
    const plugin = new TestPlugin('livePlugin');
    plugin.beforeToolCallbackResponse = {from: 'pluginBefore'};
    ctx.pluginManager.registerPlugin(plugin);

    const canonicalBefore = vi.fn<SingleBeforeToolCallback>(() => ({
      from: 'canonicalBefore',
    }));
    const canonicalAfter = vi.fn<SingleAfterToolCallback>(() => ({
      from: 'canonicalAfter',
    }));
    const callEvent = createEvent({
      invocationId: ctx.invocationId,
      author: 'liveTestAgent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'fc-plugin-b', name: 'testTool', args: {}}},
        ],
      },
    });

    const beforeResult = await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: callEvent,
      toolsDict: {testTool},
      beforeToolCallbacks: [canonicalBefore],
      afterToolCallbacks: [],
    });

    expect(
      beforeResult?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      from: 'pluginBefore',
    });
    expect(canonicalBefore).not.toHaveBeenCalled();

    plugin.beforeToolCallbackResponse = undefined;
    plugin.afterToolCallbackResponse = {from: 'pluginAfter'};
    const afterResult = await handleFunctionCallsLive({
      invocationContext: ctx,
      functionCallEvent: callEvent,
      toolsDict: {testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [canonicalAfter],
    });

    expect(
      afterResult?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      from: 'pluginAfter',
    });
    expect(canonicalAfter).not.toHaveBeenCalled();
  });

  it('matches handleFunctionCallsAsync callback override behavior in handleFunctionCallsLive', async () => {
    const beforeCb: SingleBeforeToolCallback = () => ({
      bypassed: 'byBeforeCallback',
    });
    const asyncCtx = createLiveInvocationContext();
    const liveCtx = createLiveInvocationContext();
    const callEvent = createEvent({
      invocationId: asyncCtx.invocationId,
      author: 'liveTestAgent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'fc-override', name: 'testTool', args: {}}},
        ],
      },
    });

    const asyncResult = await handleFunctionCallsAsync({
      invocationContext: asyncCtx,
      functionCallEvent: callEvent,
      toolsDict: {testTool},
      beforeToolCallbacks: [beforeCb],
      afterToolCallbacks: [],
    });
    const liveResult = await handleFunctionCallsLive({
      invocationContext: liveCtx,
      functionCallEvent: callEvent,
      toolsDict: {testTool},
      beforeToolCallbacks: [beforeCb],
      afterToolCallbacks: [],
    });

    expect(
      asyncResult?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      bypassed: 'byBeforeCallback',
    });
    expect(liveResult?.content?.parts?.[0]?.functionResponse?.response).toEqual(
      asyncResult?.content?.parts?.[0]?.functionResponse?.response,
    );
  });
});

describe('OAuth2 credential request and response flows', () => {
  const oauth2AuthConfig: AuthConfig = {
    credentialKey: 'oauth2_tool_credential',
    authScheme: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/oauth2/authorize',
          tokenUrl: 'https://example.com/oauth2/token',
          scopes: {read: 'Read access'},
        },
      },
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'client-id-123',
        clientSecret: 'client-secret-456',
        redirectUri: 'https://example.com/callback',
      },
    },
  };

  function createProtectedTool() {
    return new FunctionTool({
      name: 'protectedTool',
      description: 'tool requiring OAuth2 credentials',
      parameters: z.object({query: z.string()}),
      execute: async ({query}, toolContext) => {
        const credential = toolContext?.getAuthResponse(oauth2AuthConfig);
        if (!credential) {
          toolContext?.requestCredential(oauth2AuthConfig);
          return {status: 'pending_credentials'};
        }
        return {
          query,
          accessToken: credential.oauth2?.accessToken ?? null,
          refreshToken: credential.oauth2?.refreshToken ?? null,
        };
      },
    });
  }

  it('requests OAuth2 credentials via requestedAuthConfigs and emits an adk_request_credential call', async () => {
    const protectedTool = createProtectedTool();
    const agent = new LlmAgent({
      name: 'auth_agent',
      model: 'gemini-2.0-flash',
      tools: [protectedTool],
    });
    const session = createSession({
      id: 'sess-euc-1',
      userId: 'user-euc-1',
      appName: 'app-euc-1',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-euc-1',
      agent,
      session,
      pluginManager: new PluginManager(),
    });
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'auth_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-protected-1',
              name: 'protectedTool',
              args: {query: 'secret-report'},
            },
          },
        ],
      },
    });

    const functionResponseEvent = await handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {protectedTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(functionResponseEvent).not.toBeNull();
    expect(
      functionResponseEvent?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      status: 'pending_credentials',
    });

    const requestedConfig =
      functionResponseEvent?.actions?.requestedAuthConfigs?.['fc-protected-1'];
    expect(requestedConfig).toBeDefined();
    expect(requestedConfig?.exchangedAuthCredential?.oauth2?.authUri).toContain(
      'https://example.com/oauth2/authorize',
    );
    expect(
      requestedConfig?.exchangedAuthCredential?.oauth2?.state,
    ).toBeTruthy();

    const authEvent = generateAuthEvent(
      invocationContext,
      functionResponseEvent!,
    );
    expect(authEvent).not.toBeNull();
    const authCall = authEvent?.content?.parts?.[0]?.functionCall;
    expect(authCall?.name).toBe(REQUEST_CREDENTIAL_FUNCTION_CALL_NAME);
    expect(authCall?.args).toEqual({
      function_call_id: 'fc-protected-1',
      auth_config: requestedConfig,
    });
  });

  it('stores exchanged OAuth2 accessToken and refreshToken and resumes the waiting tool via AUTH_PREPROCESSOR', async () => {
    const protectedTool = createProtectedTool();
    const agent = new LlmAgent({
      name: 'auth_agent',
      model: 'gemini-2.0-flash',
      tools: [protectedTool],
    });
    const originalCallEvent = createEvent({
      invocationId: 'inv-euc-2',
      author: 'auth_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-protected-2',
              name: 'protectedTool',
              args: {query: 'secret-report'},
            },
          },
        ],
      },
    });
    const authRequestEvent = createEvent({
      invocationId: 'inv-euc-2',
      author: 'auth_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-auth-req-2',
              name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
              args: {
                functionCallId: 'fc-protected-2',
                authConfig: oauth2AuthConfig,
              },
            },
          },
        ],
      },
    });
    const userAuthResponseEvent = createEvent({
      invocationId: 'inv-euc-2',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-auth-req-2',
              name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
              response: {
                exchangedAuthCredential: {
                  authType: AuthCredentialTypes.OAUTH2,
                  oauth2: {
                    clientId: 'client-id-123',
                    clientSecret: 'client-secret-456',
                    accessToken: 'exchanged-access-token',
                    refreshToken: 'exchanged-refresh-token',
                  },
                },
              },
            },
          },
        ],
      },
    });
    const session = createSession({
      id: 'sess-euc-2',
      userId: 'user-euc-2',
      appName: 'app-euc-2',
      events: [originalCallEvent, authRequestEvent, userAuthResponseEvent],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-euc-2',
      agent,
      session,
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of AUTH_PREPROCESSOR.runAsync(invocationContext)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0]?.functionResponse).toEqual({
      id: 'fc-protected-2',
      name: 'protectedTool',
      response: {
        query: 'secret-report',
        accessToken: 'exchanged-access-token',
        refreshToken: 'exchanged-refresh-token',
      },
    });
  });
});

describe('async tool callbacks on LlmAgent', () => {
  async function invokeToolWithCallbacks({
    beforeToolCallback,
    afterToolCallback,
  }: {
    beforeToolCallback?: BeforeToolCallback;
    afterToolCallback?: AfterToolCallback;
  }): Promise<Event | null> {
    const tool = new FunctionTool({
      name: 'simple_fn',
      description: 'simple function',
      parameters: z.object({}),
      execute: () => ({initial: 'response'}),
    });
    const agent = new LlmAgent({
      name: 'agent',
      model: 'gemini-flash-latest',
      tools: [tool],
      beforeToolCallback,
      afterToolCallback,
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-async-cb',
      agent,
      session: createSession({
        id: 'sess-async-cb',
        userId: 'user-async-cb',
        appName: 'app-async-cb',
      }),
      pluginManager: new PluginManager(),
    });
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: agent.name,
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: tool.name, args: {}}}],
      },
    });
    return handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: agent.canonicalBeforeToolCallbacks,
      afterToolCallbacks: agent.canonicalAfterToolCallbacks,
    });
  }

  it('executes an async beforeToolCallback and returns its response', async () => {
    const mockResp = {test: 'before_tool_callback'};
    const resultEvent = await invokeToolWithCallbacks({
      beforeToolCallback: async () => mockResp,
    });

    expect(resultEvent).not.toBeNull();
    expect(
      resultEvent?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual(mockResp);
  });

  it('executes an async afterToolCallback and returns its response', async () => {
    const mockResp = {test: 'after_tool_callback'};
    const resultEvent = await invokeToolWithCallbacks({
      afterToolCallback: async () => mockResp,
    });

    expect(resultEvent).not.toBeNull();
    expect(
      resultEvent?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual(mockResp);
  });

  const CALLBACK_PARAMS: Array<{
    name: string;
    callbacks: Array<{
      response: Record<string, unknown> | undefined;
      isAsync: boolean;
    }>;
    expectedResponse: Record<string, unknown>;
    expectedCalls: number[];
  }> = [
    {
      name: 'when middle async callback returns content',
      callbacks: [
        {response: undefined, isAsync: false},
        {response: {test: 'callback_2_response'}, isAsync: true},
        {response: {test: 'callback_3_response'}, isAsync: false},
        {response: undefined, isAsync: true},
      ],
      expectedResponse: {test: 'callback_2_response'},
      expectedCalls: [1, 1, 0, 0],
    },
    {
      name: 'when all callbacks return undefined',
      callbacks: [
        {response: undefined, isAsync: false},
        {response: undefined, isAsync: true},
        {response: undefined, isAsync: false},
        {response: undefined, isAsync: true},
      ],
      expectedResponse: {initial: 'response'},
      expectedCalls: [1, 1, 1, 1],
    },
    {
      name: 'when first sync callback returns content',
      callbacks: [
        {response: {test: 'callback_1_response'}, isAsync: false},
        {response: {test: 'callback_2_response'}, isAsync: true},
      ],
      expectedResponse: {test: 'callback_1_response'},
      expectedCalls: [1, 0],
    },
  ];

  it.each(CALLBACK_PARAMS)(
    'executes beforeToolCallback chain ($name)',
    async ({callbacks, expectedResponse, expectedCalls}) => {
      const mockBeforeCbs: SingleBeforeToolCallback[] = callbacks.map(
        ({response, isAsync}) =>
          isAsync ? vi.fn(async () => response) : vi.fn(() => response),
      );

      const resultEvent = await invokeToolWithCallbacks({
        beforeToolCallback: mockBeforeCbs,
      });

      expect(resultEvent).not.toBeNull();
      expect(
        resultEvent?.content?.parts?.[0]?.functionResponse?.response,
      ).toEqual(expectedResponse);

      for (let i = 0; i < mockBeforeCbs.length; i++) {
        expect(mockBeforeCbs[i]).toHaveBeenCalledTimes(expectedCalls[i]);
      }
    },
  );

  it.each(CALLBACK_PARAMS)(
    'executes afterToolCallback chain ($name)',
    async ({callbacks, expectedResponse, expectedCalls}) => {
      const mockAfterCbs: SingleAfterToolCallback[] = callbacks.map(
        ({response, isAsync}) =>
          isAsync ? vi.fn(async () => response) : vi.fn(() => response),
      );

      const resultEvent = await invokeToolWithCallbacks({
        afterToolCallback: mockAfterCbs,
      });

      expect(resultEvent).not.toBeNull();
      expect(
        resultEvent?.content?.parts?.[0]?.functionResponse?.response,
      ).toEqual(expectedResponse);

      for (let i = 0; i < mockAfterCbs.length; i++) {
        expect(mockAfterCbs[i]).toHaveBeenCalledTimes(expectedCalls[i]);
      }
    },
  );
});

describe('computer use function responses', () => {
  function makeInvocationContext(): InvocationContext {
    return new InvocationContext({
      invocationId: 'inv_computer_use',
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager: new PluginManager(),
    });
  }

  async function respond(tool: BaseTool): Promise<FunctionResponse> {
    const event = await handleFunctionCallList({
      invocationContext: makeInvocationContext(),
      functionCalls: [callFor(tool)],
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    const functionResponse = event?.content?.parts?.[0].functionResponse;
    if (!functionResponse) {
      throw new Error('No function response in the event');
    }
    return functionResponse;
  }

  function computerUseTool(result: unknown): ComputerUseTool {
    return new ComputerUseTool({
      name: 'current_state',
      description: 'Returns the current state.',
      screenSize: [1920, 1080],
      execute: () => result,
    });
  }

  it('sends the screenshot as an inline image part', async () => {
    const functionResponse = await respond(
      computerUseTool({
        screenshot: new Uint8Array([1, 2, 3]),
        url: 'https://example.com',
      }),
    );

    expect(functionResponse.response).toEqual({url: 'https://example.com'});
    expect(functionResponse.parts).toEqual([
      {inlineData: {data: 'AQID', mimeType: 'image/png'}},
    ]);
  });

  it('leaves an image that is not base64 in the response', async () => {
    const image = {data: 'not base64!', mimetype: 'image/png'};

    const functionResponse = await respond(computerUseTool({image}));

    expect(functionResponse.response).toEqual({image});
    expect(functionResponse.parts).toBeUndefined();
  });

  it('leaves the image of a tool that is not a computer use tool', async () => {
    const image = {data: 'AQID', mimetype: 'image/png'};
    const tool = new FunctionTool({
      name: 'imageTool',
      description: 'returns an image field',
      execute: async () => ({image}),
    });

    const functionResponse = await respond(tool);

    expect(functionResponse.response).toEqual({image});
    expect(functionResponse.parts).toBeUndefined();
  });
});

class RecordingResponsesLlm extends BaseLlm {
  readonly requestContents: Content[][] = [];
  private index = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'recording-mock-llm'});
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requestContents.push(structuredClone(request.contents));
    const response = this.responses[this.index++];
    if (response) {
      yield response;
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not implemented in RecordingResponsesLlm.');
  }
}

describe('parallel tool state merging and multi-tool EUC resumption', () => {
  it('merges parallel tool stateDelta including nested plain objects and transferToAgent across Runner', async () => {
    let callsCount = 0;
    const updateNestedState = new FunctionTool({
      name: 'updateNestedState',
      description: 'updates a nested key in session state',
      parameters: z.object({
        key: z.string(),
        nestedField: z.string(),
        nestedValue: z.string(),
      }),
      execute: async ({key, nestedField, nestedValue}, toolContext) => {
        callsCount += 1;
        toolContext?.state.set(key, {[nestedField]: nestedValue});
        return null;
      },
    });

    const subAgentLlm = new RecordingResponsesLlm([
      {content: {role: 'model', parts: [{text: 'sub agent response'}]}},
    ]);
    const subAgent = new LlmAgent({
      name: 'testSubAgent',
      model: subAgentLlm,
    });
    const rootLlm = new RecordingResponsesLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'updateNestedState',
                args: {
                  key: 'profile',
                  nestedField: 'name',
                  nestedValue: 'Ada',
                },
              },
            },
            {
              functionCall: {
                id: 'call-2',
                name: 'updateNestedState',
                args: {
                  key: 'profile',
                  nestedField: 'role',
                  nestedValue: 'admin',
                },
              },
            },
            {
              functionCall: {
                id: 'call-3',
                name: 'transfer_to_agent',
                args: {agent_name: 'testSubAgent'},
              },
            },
          ],
        },
      },
    ]);
    const rootAgent = new LlmAgent({
      name: 'rootAgent',
      model: rootLlm,
      tools: [updateNestedState],
      subAgents: [subAgent],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'parallel-app',
      userId: 'user-1',
    });
    const runner = new Runner({
      appName: 'parallel-app',
      agent: rootAgent,
      sessionService,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'test'}]},
    })) {
      events.push(event);
    }

    expect(callsCount).toBe(2);
    expect(events).toHaveLength(3);
    expect(events[1].actions.stateDelta).toEqual({
      profile: {name: 'Ada', role: 'admin'},
    });
    expect(events[1].actions.transferToAgent).toBe('testSubAgent');
    expect(events[2].author).toBe('testSubAgent');
    expect(events[2].content?.parts?.[0]?.text).toBe('sub agent response');
    const updatedSession = await sessionService.getSession({
      appName: 'parallel-app',
      userId: 'user-1',
      sessionId: session.id,
    });
    expect(updatedSession?.state).toEqual({
      profile: {name: 'Ada', role: 'admin'},
    });
  });

  it('resumes multiple EUC-gated tools across consecutive turns and merges partial function responses', async () => {
    function createApiKeyConfig(
      credentialKey: string,
      headerName: string,
    ): AuthConfig {
      return {
        credentialKey,
        authScheme: {
          type: 'apiKey',
          in: 'header',
          name: headerName,
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
        },
      };
    }

    const authConfig1 = createApiKeyConfig('credKey1', 'X-Api-Key-1');
    const authConfig2 = createApiKeyConfig('credKey2', 'X-Api-Key-2');

    let functionInvoked = 0;
    const callExternalApi1 = new FunctionTool({
      name: 'callExternalApi1',
      description: 'calls external API 1',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        functionInvoked += 1;
        const auth = toolContext?.getAuthResponse(authConfig1);
        if (!auth) {
          toolContext?.requestCredential(authConfig1);
          return null;
        }
        expect(auth.apiKey).toBe('token1');
        return 1;
      },
    });
    const callExternalApi2 = new FunctionTool({
      name: 'callExternalApi2',
      description: 'calls external API 2',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        functionInvoked += 1;
        const auth = toolContext?.getAuthResponse(authConfig2);
        if (!auth) {
          toolContext?.requestCredential(authConfig2);
          return null;
        }
        expect(auth.apiKey).toBe('token2');
        return 2;
      },
    });

    const mockLlm = new RecordingResponsesLlm([
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'id-1', name: 'callExternalApi1', args: {}}},
            {functionCall: {id: 'id-2', name: 'callExternalApi2', args: {}}},
          ],
        },
      },
      {content: {role: 'model', parts: [{text: 'response1'}]}},
      {content: {role: 'model', parts: [{text: 'response2'}]}},
    ]);

    const agent = new LlmAgent({
      name: 'rootAgent',
      model: mockLlm,
      tools: [callExternalApi1, callExternalApi2],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'euc-partial-app',
      userId: 'user-1',
    });
    const runner = new Runner({
      appName: 'euc-partial-app',
      agent,
      sessionService,
    });

    const collectTurn = async (newMessage: Content): Promise<Event[]> => {
      const turnEvents: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'user-1',
        sessionId: session.id,
        newMessage,
      })) {
        turnEvents.push(event);
      }
      return turnEvents;
    };

    const turn1Events = await collectTurn({
      role: 'user',
      parts: [{text: 'test'}],
    });
    expect(functionInvoked).toBe(2);

    const authRequestEvent = turn1Events.find((e) =>
      getFunctionCalls(e).some(
        (fc) => fc.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
      ),
    );
    if (!authRequestEvent) {
      throw new Error('Expected an adk_request_credential event in turn 1');
    }
    const authCalls = getFunctionCalls(authRequestEvent);
    expect(authCalls).toHaveLength(2);

    // Turn 2: supply only the first credential; API 1 resolves while API 2 stays pending.
    await collectTurn({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: authCalls[0].id,
            name: authCalls[0].name,
            response: {
              exchangedAuthCredential: {
                authType: AuthCredentialTypes.API_KEY,
                apiKey: 'token1',
              },
            },
          },
        },
      ],
    });

    expect(functionInvoked).toBe(3);
    expect(mockLlm.requestContents).toHaveLength(2);
    const partialMergedParts = mockLlm.requestContents[1].at(-1)?.parts;
    expect(partialMergedParts).toHaveLength(2);
    expect(partialMergedParts?.[0]?.functionResponse?.name).toBe(
      'callExternalApi1',
    );
    expect(partialMergedParts?.[0]?.functionResponse?.response).toEqual({
      result: 1,
    });
    expect(partialMergedParts?.[1]?.functionResponse?.name).toBe(
      'callExternalApi2',
    );
    expect(partialMergedParts?.[1]?.functionResponse?.response).toEqual({
      result: null,
    });

    // Turn 3: supply the second credential; both tool responses are merged.
    await collectTurn({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: authCalls[1].id,
            name: authCalls[1].name,
            response: {
              exchangedAuthCredential: {
                authType: AuthCredentialTypes.API_KEY,
                apiKey: 'token2',
              },
            },
          },
        },
      ],
    });

    expect(functionInvoked).toBe(4);
    expect(mockLlm.requestContents).toHaveLength(3);
    const finalMergedParts = mockLlm.requestContents[2].at(-1)?.parts;
    expect(finalMergedParts).toHaveLength(2);
    expect(finalMergedParts?.[0]?.functionResponse?.name).toBe(
      'callExternalApi1',
    );
    expect(finalMergedParts?.[0]?.functionResponse?.response).toEqual({
      result: 1,
    });
    expect(finalMergedParts?.[1]?.functionResponse?.name).toBe(
      'callExternalApi2',
    );
    expect(finalMergedParts?.[1]?.functionResponse?.response).toEqual({
      result: 2,
    });
  });
});

describe('functionCall.args deep cloning', () => {
  function createCloneTestContext(
    agent: LlmAgent,
    plugins: BasePlugin[] = [],
  ): InvocationContext {
    return new InvocationContext({
      invocationId: 'inv-args-clone',
      agent,
      session: createSession({
        id: 'sess-args-clone',
        userId: 'user-args-clone',
        appName: 'app-args-clone',
      }),
      liveRequestQueue: new LiveRequestQueue(),
      pluginManager: new PluginManager(plugins),
    });
  }

  function isNestedClonePayload(value: unknown): value is {
    nestedObject: {inner: {value: string}};
    items: string[];
  } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'nestedObject' in value &&
      'items' in value &&
      Array.isArray(value.items)
    );
  }

  it('passes a distinct copy of functionCall.args to tools and callbacks in async and live modes', async () => {
    const receivedRefs: unknown[] = [];
    const inspectTool = new FunctionTool({
      name: 'inspectTool',
      description: 'captures the args object reference',
      parameters: {type: Type.OBJECT},
      execute: async (input) => {
        receivedRefs.push(input);
        return {result: 'ok'};
      },
    });
    const beforeCallback: SingleBeforeToolCallback = async ({args}) => {
      receivedRefs.push(args);
      return undefined;
    };
    const afterCallback: SingleAfterToolCallback = async ({args}) => {
      receivedRefs.push(args);
      return undefined;
    };
    const agent = new LlmAgent({
      name: 'cloneAgent',
      model: 'gemini-flash-latest',
      tools: [inspectTool],
    });
    const invocationContext = createCloneTestContext(agent);
    const originalArgs: Record<string, unknown> = {
      param1: 'value1',
      param2: 42,
    };
    const functionCall: FunctionCall = {
      id: 'fc-clone-1',
      name: inspectTool.name,
      args: originalArgs,
    };
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: agent.name,
      content: {role: 'model', parts: [{functionCall}]},
    });

    const asyncResult = await handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {[inspectTool.name]: inspectTool},
      beforeToolCallbacks: [beforeCallback],
      afterToolCallbacks: [afterCallback],
    });
    const liveResult = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent,
      toolsDict: {[inspectTool.name]: inspectTool},
      beforeToolCallbacks: [beforeCallback],
      afterToolCallbacks: [afterCallback],
    });

    expect(asyncResult).not.toBeNull();
    expect(liveResult).not.toBeNull();
    expect(receivedRefs).toHaveLength(6);
    for (const ref of receivedRefs) {
      expect(ref).toEqual(originalArgs);
      expect(ref).not.toBe(originalArgs);
    }
    expect(functionCall.args).toEqual({param1: 'value1', param2: 42});
  });

  it('defaults undefined functionCall.args to an empty object in async and live modes', async () => {
    const simpleTool = new FunctionTool({
      name: 'simpleTool',
      description: 'handles empty args',
      parameters: {type: Type.OBJECT},
      execute: async (input) => ({
        receivedKeys:
          typeof input === 'object' && input !== null ? Object.keys(input) : [],
      }),
    });
    const agent = new LlmAgent({
      name: 'cloneAgent',
      model: 'gemini-flash-latest',
      tools: [simpleTool],
    });
    const invocationContext = createCloneTestContext(agent);
    const functionCall: FunctionCall = {
      id: 'fc-undef-args',
      name: simpleTool.name,
      args: undefined,
    };
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: agent.name,
      content: {role: 'model', parts: [{functionCall}]},
    });

    const asyncResult = await handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {[simpleTool.name]: simpleTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    const liveResult = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent,
      toolsDict: {[simpleTool.name]: simpleTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(
      asyncResult?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      receivedKeys: [],
    });
    expect(liveResult?.content?.parts?.[0]?.functionResponse?.response).toEqual(
      {
        receivedKeys: [],
      },
    );
    expect(functionCall.args).toBeUndefined();
  });

  it('preserves top-level functionCall.args when a callback or tool mutates the copied args', async () => {
    const echoTool = new FunctionTool({
      name: 'echoTool',
      description: 'echoes and mutates top-level args',
      parameters: {type: Type.OBJECT},
      execute: async (input) => {
        if (
          typeof input === 'object' &&
          input !== null &&
          'textParam' in input &&
          'countParam' in input
        ) {
          const receivedArgs = {
            textParam: input.textParam,
            countParam: input.countParam,
          };
          input.textParam = 'mutatedInTool';
          return {result: 'ok', receivedArgs};
        }
        return {result: 'unexpected'};
      },
    });
    const beforeCallback: SingleBeforeToolCallback = async ({args}) => {
      args['mutatedByBefore'] = true;
      return undefined;
    };
    const afterCallback: SingleAfterToolCallback = async ({args}) => {
      args['mutatedByAfter'] = true;
      return undefined;
    };
    const agent = new LlmAgent({
      name: 'cloneAgent',
      model: 'gemini-flash-latest',
      tools: [echoTool],
    });
    const invocationContext = createCloneTestContext(agent);
    const originalArgs = {textParam: 'originalValue', countParam: 123};
    const functionCall: FunctionCall = {
      id: 'fc-top-level',
      name: echoTool.name,
      args: originalArgs,
    };
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: agent.name,
      content: {role: 'model', parts: [{functionCall}]},
    });

    const asyncResult = await handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {[echoTool.name]: echoTool},
      beforeToolCallbacks: [beforeCallback],
      afterToolCallbacks: [afterCallback],
    });

    expect(functionCall.args).toEqual({
      textParam: 'originalValue',
      countParam: 123,
    });
    expect(
      asyncResult?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      result: 'ok',
      receivedArgs: {textParam: 'originalValue', countParam: 123},
    });
  });

  it('deep-clones functionCall.args before plugin callbacks and unresolvable tool error handlers', async () => {
    class MutatingArgsPlugin extends BasePlugin {
      constructor() {
        super('mutatingArgsPlugin');
      }

      override async beforeToolCallback({
        toolArgs,
      }: {
        tool: BaseTool;
        toolArgs: Record<string, unknown>;
        toolContext: Context;
      }): Promise<Record<string, unknown> | undefined> {
        if (isNestedClonePayload(toolArgs)) {
          toolArgs.nestedObject.inner.value = 'mutatedByPluginBefore';
          toolArgs.items.push('beforeItem');
        }
        return undefined;
      }

      override async afterToolCallback({
        toolArgs,
      }: {
        tool: BaseTool;
        toolArgs: Record<string, unknown>;
        toolContext: Context;
        result: Record<string, unknown>;
      }): Promise<Record<string, unknown> | undefined> {
        if (isNestedClonePayload(toolArgs)) {
          toolArgs.nestedObject.inner.value = 'mutatedByPluginAfter';
          toolArgs.items.push('afterItem');
        }
        return undefined;
      }

      override async onToolErrorCallback({
        toolArgs,
      }: {
        tool: BaseTool;
        toolArgs: Record<string, unknown>;
        toolContext: Context;
        error: Error;
      }): Promise<Record<string, unknown> | undefined> {
        if (isNestedClonePayload(toolArgs)) {
          toolArgs.nestedObject.inner.value = 'mutatedByOnToolError';
          toolArgs.items.push('errorItem');
        }
        return {handled: true};
      }
    }

    const okTool = new FunctionTool({
      name: 'okTool',
      description: 'returns ok',
      parameters: {type: Type.OBJECT},
      execute: async () => ({status: 'ok'}),
    });
    const agent = new LlmAgent({
      name: 'cloneAgent',
      model: 'gemini-flash-latest',
      tools: [okTool],
    });
    const invocationContext = createCloneTestContext(agent, [
      new MutatingArgsPlugin(),
    ]);
    const resolvedNested = {inner: {value: 'original'}};
    const resolvedItems = ['item1'];
    const resolvedCall: FunctionCall = {
      id: 'fc-plugin-resolved',
      name: okTool.name,
      args: {nestedObject: resolvedNested, items: resolvedItems},
    };
    const missingNested = {inner: {value: 'originalMissing'}};
    const missingItems = ['missing1'];
    const missingCall: FunctionCall = {
      id: 'fc-plugin-missing',
      name: 'missingTool',
      args: {nestedObject: missingNested, items: missingItems},
    };
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: agent.name,
      content: {
        role: 'model',
        parts: [{functionCall: resolvedCall}, {functionCall: missingCall}],
      },
    });

    const result = await handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {[okTool.name]: okTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(result).not.toBeNull();
    expect(result?.content?.parts?.[0]?.functionResponse?.response).toEqual({
      status: 'ok',
    });
    expect(result?.content?.parts?.[1]?.functionResponse?.response).toEqual({
      handled: true,
    });
    expect(resolvedCall.args).toEqual({
      nestedObject: {inner: {value: 'original'}},
      items: ['item1'],
    });
    expect(missingCall.args).toEqual({
      nestedObject: {inner: {value: 'originalMissing'}},
      items: ['missing1'],
    });
    expect(resolvedNested.inner.value).toBe('original');
    expect(resolvedItems).toEqual(['item1']);
    expect(missingNested.inner.value).toBe('originalMissing');
    expect(missingItems).toEqual(['missing1']);
  });

  it('deep-clones nested objects and arrays so in-place mutations do not affect functionCall.args', async () => {
    const mutatingTool = new FunctionTool({
      name: 'mutatingTool',
      description: 'mutates nested structures in place',
      parameters: {type: Type.OBJECT},
      execute: async (input) => {
        if (isNestedClonePayload(input)) {
          input.nestedObject.inner.value = 'modified';
          input.items.push('newItem');
          return {
            result: 'ok',
            receivedNested: input.nestedObject,
            receivedItems: input.items,
          };
        }
        return {result: 'unexpected'};
      },
    });
    const agent = new LlmAgent({
      name: 'cloneAgent',
      model: 'gemini-flash-latest',
      tools: [mutatingTool],
    });
    const invocationContext = createCloneTestContext(agent);
    const originalNested = {inner: {value: 'original'}};
    const originalItems = ['item1', 'item2'];
    const originalArgs = {
      nestedObject: originalNested,
      items: originalItems,
    };
    const functionCall: FunctionCall = {
      id: 'fc-deep-copy',
      name: mutatingTool.name,
      args: originalArgs,
    };
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: agent.name,
      content: {role: 'model', parts: [{functionCall}]},
    });

    const asyncResult = await handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {[mutatingTool.name]: mutatingTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    const liveResult = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent,
      toolsDict: {[mutatingTool.name]: mutatingTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(functionCall.args).toEqual({
      nestedObject: {inner: {value: 'original'}},
      items: ['item1', 'item2'],
    });
    expect(originalNested.inner.value).toBe('original');
    expect(originalItems).toEqual(['item1', 'item2']);
    expect(
      asyncResult?.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      result: 'ok',
      receivedNested: {inner: {value: 'modified'}},
      receivedItems: ['item1', 'item2', 'newItem'],
    });
    expect(liveResult?.content?.parts?.[0]?.functionResponse?.response).toEqual(
      {
        result: 'ok',
        receivedNested: {inner: {value: 'modified'}},
        receivedItems: ['item1', 'item2', 'newItem'],
      },
    );
  });
});

describe('concurrent parallel function-call execution and state ordering', () => {
  interface RunParallelTurnOptions {
    tools: BaseTool[];
    functionCalls: FunctionCall[];
    initialState?: Record<string, unknown>;
  }

  async function runParallelTurn({
    tools,
    functionCalls,
    initialState,
  }: RunParallelTurnOptions): Promise<{
    events: Event[];
    storedState: Record<string, unknown>;
  }> {
    const appName = 'parallel-exec-app';
    const userId = 'user-1';
    const mockLlm = new RecordingResponsesLlm([
      {
        content: {
          role: 'model',
          parts: functionCalls.map((functionCall) => ({functionCall})),
        },
      },
      {content: {role: 'model', parts: [{text: 'done'}]}},
    ]);
    const agent = new LlmAgent({
      name: 'testAgent',
      model: mockLlm,
      tools,
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName,
      userId,
      state: initialState,
    });
    const runner = new Runner({
      appName,
      agent,
      sessionService,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'run tools'}]},
    })) {
      events.push(event);
    }

    const storedSession = await sessionService.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    return {
      events,
      storedState: storedSession?.state ?? {},
    };
  }

  it('returns null when no function calls match the filter', async () => {
    const agent = new LlmAgent({
      name: 'filterAgent',
      model: 'gemini-flash-latest',
      tools: [testTool],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-empty-filter',
      agent,
      session: createSession({
        id: 'sess-empty-filter',
        appName: 'parallel-exec-app',
        userId: 'user-1',
      }),
      pluginManager: new PluginManager(),
    });

    const emptyResult = await handleFunctionCallList({
      invocationContext,
      functionCalls: [],
      toolsDict: {testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    const filteredOutResult = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'fc-1', name: 'testTool', args: {}}],
      toolsDict: {testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
      filters: new Set(['fc-other']),
    });

    expect(emptyResult).toBeNull();
    expect(filteredOutResult).toBeNull();
  });

  it('starts multiple async tool calls concurrently in Runner.runAsync and merges responses in call order', async () => {
    const executionLog: string[] = [];

    const slowTool1 = new FunctionTool({
      name: 'slowTool1',
      description: 'first async tool finishing second',
      parameters: z.object({}),
      execute: async () => {
        executionLog.push('start1');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        executionLog.push('end1');
        return {result: 'firstResult'};
      },
    });
    const slowTool2 = new FunctionTool({
      name: 'slowTool2',
      description: 'second async tool finishing first',
      parameters: z.object({}),
      execute: async () => {
        executionLog.push('start2');
        await Promise.resolve();
        executionLog.push('end2');
        return {result: 'secondResult'};
      },
    });

    const {events} = await runParallelTurn({
      tools: [slowTool1, slowTool2],
      functionCalls: [
        {id: 'fc-1', name: 'slowTool1', args: {}},
        {id: 'fc-2', name: 'slowTool2', args: {}},
      ],
    });

    const lastStart = Math.max(
      executionLog.indexOf('start1'),
      executionLog.indexOf('start2'),
    );
    const firstEnd = Math.min(
      executionLog.indexOf('end1'),
      executionLog.indexOf('end2'),
    );
    expect(lastStart).toBeGreaterThanOrEqual(0);
    expect(lastStart).toBeLessThan(firstEnd);
    expect(executionLog).toEqual(['start1', 'start2', 'end2', 'end1']);

    expect(events).toHaveLength(3);
    const responses = getFunctionResponses(events[1]);
    expect(responses).toEqual([
      {id: 'fc-1', name: 'slowTool1', response: {result: 'firstResult'}},
      {id: 'fc-2', name: 'slowTool2', response: {result: 'secondResult'}},
    ]);
  });

  it('starts multiple async tool calls concurrently in handleFunctionCallsLive and merges responses in call order', async () => {
    const executionLog: string[] = [];

    const slowLiveTool1 = new FunctionTool({
      name: 'slowLiveTool1',
      description: 'first live async tool finishing second',
      parameters: z.object({}),
      execute: async () => {
        executionLog.push('start1');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        executionLog.push('end1');
        return {result: 'liveFirst'};
      },
    });
    const slowLiveTool2 = new FunctionTool({
      name: 'slowLiveTool2',
      description: 'second live async tool finishing first',
      parameters: z.object({}),
      execute: async () => {
        executionLog.push('start2');
        await Promise.resolve();
        executionLog.push('end2');
        return {result: 'liveSecond'};
      },
    });

    const agent = new LlmAgent({
      name: 'liveParallelAgent',
      model: 'gemini-flash-latest',
      tools: [slowLiveTool1, slowLiveTool2],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-live-parallel',
      agent,
      session: createSession({
        id: 'sess-live-parallel',
        appName: 'parallel-exec-app',
        userId: 'user-1',
      }),
      liveRequestQueue: new LiveRequestQueue(),
      pluginManager: new PluginManager(),
    });
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: agent.name,
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'fc-live-1', name: 'slowLiveTool1', args: {}}},
          {functionCall: {id: 'fc-live-2', name: 'slowLiveTool2', args: {}}},
        ],
      },
    });

    const mergedEvent = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent,
      toolsDict: {slowLiveTool1, slowLiveTool2},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const lastStart = Math.max(
      executionLog.indexOf('start1'),
      executionLog.indexOf('start2'),
    );
    const firstEnd = Math.min(
      executionLog.indexOf('end1'),
      executionLog.indexOf('end2'),
    );
    expect(lastStart).toBeGreaterThanOrEqual(0);
    expect(lastStart).toBeLessThan(firstEnd);
    expect(executionLog).toEqual(['start1', 'start2', 'end2', 'end1']);

    expect(mergedEvent).not.toBeNull();
    expect(mergedEvent ? getFunctionResponses(mergedEvent) : []).toEqual([
      {id: 'fc-live-1', name: 'slowLiveTool1', response: {result: 'liveFirst'}},
      {
        id: 'fc-live-2',
        name: 'slowLiveTool2',
        response: {result: 'liveSecond'},
      },
    ]);
  });

  it('merges state updates from parallel synchronous tools on toolContext.state', async () => {
    const stateSnapshots: Array<[string, Record<string, unknown>]> = [];

    const modifyState1 = new FunctionTool({
      name: 'modifyState1',
      description: 'increments counter and records first flag',
      parameters: z.object({}),
      execute: (_args, toolContext) => {
        if (!toolContext) {
          return {result: 'missingContext'};
        }
        stateSnapshots.push(['tool1Start', {...toolContext.state.toRecord()}]);
        const current = toolContext.state.get<number>('counter') ?? 0;
        toolContext.state.set('counter', current + 1);
        toolContext.state.set('tool1Executed', true);
        stateSnapshots.push(['tool1End', {...toolContext.state.toRecord()}]);
        return {result: 'modified1'};
      },
    });
    const modifyState2 = new FunctionTool({
      name: 'modifyState2',
      description: 'increments counter and records second flag',
      parameters: z.object({}),
      execute: (_args, toolContext) => {
        if (!toolContext) {
          return {result: 'missingContext'};
        }
        stateSnapshots.push(['tool2Start', {...toolContext.state.toRecord()}]);
        const current = toolContext.state.get<number>('counter') ?? 0;
        toolContext.state.set('counter', current + 1);
        toolContext.state.set('tool2Executed', true);
        stateSnapshots.push(['tool2End', {...toolContext.state.toRecord()}]);
        return {result: 'modified2'};
      },
    });

    const {events, storedState} = await runParallelTurn({
      tools: [modifyState1, modifyState2],
      functionCalls: [
        {id: 'fc-1', name: 'modifyState1', args: {}},
        {id: 'fc-2', name: 'modifyState2', args: {}},
      ],
    });

    expect(events[1]?.actions.stateDelta).toEqual({
      counter: 2,
      tool1Executed: true,
      tool2Executed: true,
    });
    expect(storedState).toEqual({
      counter: 2,
      tool1Executed: true,
      tool2Executed: true,
    });
    expect(stateSnapshots.map(([stage]) => stage)).toEqual([
      'tool1Start',
      'tool1End',
      'tool2Start',
      'tool2End',
    ]);
  });

  it('blocks a sibling yielding async tool until a synchronous tool finishes', async () => {
    const executionOrder: string[] = [];

    const blockingSyncTool = new FunctionTool({
      name: 'blockingSyncTool',
      description: 'performs synchronous CPU work',
      parameters: z.object({}),
      execute: () => {
        executionOrder.push('syncA');
        let acc = 0;
        for (let i = 0; i < 10_000; i++) {
          acc += i;
        }
        executionOrder.push('syncB');
        return {result: acc > 0 ? 'syncDone' : 'empty'};
      },
    });
    const yieldingAsyncTool = new FunctionTool({
      name: 'yieldingAsyncTool',
      description: 'yields control across microtasks',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('asyncC');
        await Promise.resolve();
        executionOrder.push('asyncD');
        return {result: 'asyncDone'};
      },
    });

    await runParallelTurn({
      tools: [blockingSyncTool, yieldingAsyncTool],
      functionCalls: [
        {id: 'fc-1', name: 'blockingSyncTool', args: {}},
        {id: 'fc-2', name: 'yieldingAsyncTool', args: {}},
      ],
    });

    expect(executionOrder).toEqual(['syncA', 'syncB', 'asyncC', 'asyncD']);
  });

  it('blocks a sibling yielding async tool until a non-yielding async tool finishes', async () => {
    const executionOrder: string[] = [];

    const nonYieldingAsyncTool = new FunctionTool({
      name: 'nonYieldingAsyncTool',
      description: 'async function with no await points',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('nonYieldA');
        let acc = 0;
        for (let i = 0; i < 10_000; i++) {
          acc += i;
        }
        executionOrder.push('nonYieldB');
        return {result: acc > 0 ? 'nonYieldDone' : 'empty'};
      },
    });
    const yieldingAsyncTool = new FunctionTool({
      name: 'yieldingAsyncTool',
      description: 'async function that yields control',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('yieldC');
        await Promise.resolve();
        executionOrder.push('yieldD');
        return {result: 'yieldDone'};
      },
    });

    await runParallelTurn({
      tools: [nonYieldingAsyncTool, yieldingAsyncTool],
      functionCalls: [
        {id: 'fc-1', name: 'nonYieldingAsyncTool', args: {}},
        {id: 'fc-2', name: 'yieldingAsyncTool', args: {}},
      ],
    });

    expect(executionOrder).toEqual([
      'nonYieldA',
      'nonYieldB',
      'yieldC',
      'yieldD',
    ]);
  });

  it('interleaves two yielding async tools on the event loop', async () => {
    const executionOrder: string[] = [];

    const yieldingTool1 = new FunctionTool({
      name: 'yieldingTool1',
      description: 'first yielding async tool',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('func1A');
        await Promise.resolve();
        executionOrder.push('func1B');
        return {result: 'func1Done'};
      },
    });
    const yieldingTool2 = new FunctionTool({
      name: 'yieldingTool2',
      description: 'second yielding async tool',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('func2C');
        await Promise.resolve();
        executionOrder.push('func2D');
        return {result: 'func2Done'};
      },
    });

    await runParallelTurn({
      tools: [yieldingTool1, yieldingTool2],
      functionCalls: [
        {id: 'fc-1', name: 'yieldingTool1', args: {}},
        {id: 'fc-2', name: 'yieldingTool2', args: {}},
      ],
    });

    expect(executionOrder).toEqual(['func1A', 'func2C', 'func1B', 'func2D']);
  });

  it('runs synchronous, non-yielding async, and yielding async tools in expected event-loop order', async () => {
    const executionOrder: string[] = [];

    const syncTool = new FunctionTool({
      name: 'syncTool',
      description: 'synchronous tool',
      parameters: z.object({}),
      execute: () => {
        executionOrder.push('syncA');
        executionOrder.push('syncB');
        return {result: 'syncDone'};
      },
    });
    const nonYieldingAsyncTool = new FunctionTool({
      name: 'nonYieldingAsyncTool',
      description: 'non-yielding async tool',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('nonYieldC');
        executionOrder.push('nonYieldD');
        return {result: 'nonYieldDone'};
      },
    });
    const yieldingAsyncTool = new FunctionTool({
      name: 'yieldingAsyncTool',
      description: 'yielding async tool',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('yieldE');
        await Promise.resolve();
        executionOrder.push('yieldF');
        return {result: 'yieldDone'};
      },
    });

    await runParallelTurn({
      tools: [syncTool, nonYieldingAsyncTool, yieldingAsyncTool],
      functionCalls: [
        {id: 'fc-1', name: 'syncTool', args: {}},
        {id: 'fc-2', name: 'nonYieldingAsyncTool', args: {}},
        {id: 'fc-3', name: 'yieldingAsyncTool', args: {}},
      ],
    });

    expect(executionOrder).toEqual([
      'syncA',
      'syncB',
      'nonYieldC',
      'nonYieldD',
      'yieldE',
      'yieldF',
    ]);
  });

  it('retains every item when parallel array appends on toolContext.state finish out of call order', async () => {
    let markSecondWritten: (() => void) | undefined;
    const secondWritten = new Promise<void>((resolve) => {
      markSecondWritten = resolve;
    });

    const appendItem = new FunctionTool({
      name: 'appendItem',
      description: 'appends an item to state array',
      parameters: z.object({item: z.string()}),
      execute: async ({item}, toolContext) => {
        if (item === 'a') {
          let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              secondWritten,
              new Promise<void>((resolve) => {
                fallbackTimer = setTimeout(resolve, 50);
              }),
            ]);
          } finally {
            clearTimeout(fallbackTimer);
          }
        }
        const existing = toolContext?.state.get<string[]>('items') ?? [];
        toolContext?.state.set('items', [...existing, item]);
        markSecondWritten?.();
        return null;
      },
    });

    const {events, storedState} = await runParallelTurn({
      tools: [appendItem],
      functionCalls: [
        {id: 'fc-a', name: 'appendItem', args: {item: 'a'}},
        {id: 'fc-b', name: 'appendItem', args: {item: 'b'}},
      ],
    });

    expect(events[1]?.actions.stateDelta['items']).toEqual(['b', 'a']);
    expect(storedState['items']).toEqual(['b', 'a']);
  });

  it('stores no duplicates when parallel array appends on toolContext.state finish in call order', async () => {
    const appendItem = new FunctionTool({
      name: 'appendItem',
      description: 'appends an item to state array in order',
      parameters: z.object({item: z.string()}),
      execute: async ({item}, toolContext) => {
        const existing = toolContext?.state.get<string[]>('items') ?? [];
        toolContext?.state.set('items', [...existing, item]);
        return null;
      },
    });

    const {events, storedState} = await runParallelTurn({
      tools: [appendItem],
      functionCalls: [
        {id: 'fc-a', name: 'appendItem', args: {item: 'a'}},
        {id: 'fc-b', name: 'appendItem', args: {item: 'b'}},
      ],
    });

    expect(events[1]?.actions.stateDelta['items']).toEqual(['a', 'b']);
    expect(storedState['items']).toEqual(['a', 'b']);
  });

  it('retains the latest nested array when parallel deep-cloned object writes finish out of call order', async () => {
    interface DocState {
      entities: Array<{name: string; labels: string[]}>;
    }

    let markSecondWritten: (() => void) | undefined;
    const secondWritten = new Promise<void>((resolve) => {
      markSecondWritten = resolve;
    });

    const addLabel = new FunctionTool({
      name: 'addLabel',
      description: 'adds a label to a deep-cloned document entity',
      parameters: z.object({label: z.string()}),
      execute: async ({label}, toolContext) => {
        if (label === 'a') {
          let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              secondWritten,
              new Promise<void>((resolve) => {
                fallbackTimer = setTimeout(resolve, 50);
              }),
            ]);
          } finally {
            clearTimeout(fallbackTimer);
          }
        }
        const currentDoc = toolContext?.state.get<DocState>('doc');
        if (currentDoc) {
          const clonedDoc = structuredClone(currentDoc);
          clonedDoc.entities[0]?.labels.push(label);
          toolContext?.state.set('doc', clonedDoc);
        }
        markSecondWritten?.();
        return null;
      },
    });

    const {events, storedState} = await runParallelTurn({
      tools: [addLabel],
      functionCalls: [
        {id: 'fc-a', name: 'addLabel', args: {label: 'a'}},
        {id: 'fc-b', name: 'addLabel', args: {label: 'b'}},
      ],
      initialState: {
        doc: {entities: [{name: 'e1', labels: []}]},
      },
    });

    const expectedDoc: DocState = {
      entities: [{name: 'e1', labels: ['b', 'a']}],
    };
    expect(events[1]?.actions.stateDelta['doc']).toEqual(expectedDoc);
    expect(storedState['doc']).toEqual(expectedDoc);
  });

  it('retains separate keys written in parallel to the same plain-object state entry', async () => {
    const saveDraft = new FunctionTool({
      name: 'saveDraft',
      description: 'writes a draft key into state',
      parameters: z.object({draftId: z.string()}),
      execute: async ({draftId}, toolContext) => {
        toolContext?.state.set('drafts', {[draftId]: 'body'});
        return null;
      },
    });

    const {events, storedState} = await runParallelTurn({
      tools: [saveDraft],
      functionCalls: [
        {id: 'fc-a', name: 'saveDraft', args: {draftId: 'a'}},
        {id: 'fc-b', name: 'saveDraft', args: {draftId: 'b'}},
      ],
    });

    expect(events[1]?.actions.stateDelta['drafts']).toEqual({
      a: 'body',
      b: 'body',
    });
    expect(storedState['drafts']).toEqual({
      a: 'body',
      b: 'body',
    });
  });

  it('keeps call-order precedence for direct writes to toolContext.actions.stateDelta that bypass toolContext.state', async () => {
    const setItemsDirect = new FunctionTool({
      name: 'setItemsDirect',
      description: 'writes array directly to actions.stateDelta',
      parameters: z.object({item: z.string()}),
      execute: async ({item}, toolContext) => {
        if (toolContext) {
          toolContext.actions.stateDelta['items'] = [item];
        }
        return null;
      },
    });
    const setDoneDirect = new FunctionTool({
      name: 'setDoneDirect',
      description: 'writes scalar directly to actions.stateDelta',
      parameters: z.object({doneFlag: z.string()}),
      execute: async ({doneFlag}, toolContext) => {
        if (toolContext) {
          toolContext.actions.stateDelta['done'] = doneFlag === 'yes';
        }
        return null;
      },
    });

    const arrayRun = await runParallelTurn({
      tools: [setItemsDirect],
      functionCalls: [
        {id: 'fc-a', name: 'setItemsDirect', args: {item: 'a'}},
        {id: 'fc-b', name: 'setItemsDirect', args: {item: 'b'}},
      ],
      initialState: {items: ['old']},
    });
    expect(arrayRun.events[1]?.actions.stateDelta['items']).toEqual(['b']);
    expect(arrayRun.storedState['items']).toEqual(['b']);

    const scalarRun = await runParallelTurn({
      tools: [setDoneDirect],
      functionCalls: [
        {id: 'fc-no', name: 'setDoneDirect', args: {doneFlag: 'no'}},
        {id: 'fc-yes', name: 'setDoneDirect', args: {doneFlag: 'yes'}},
      ],
      initialState: {done: false},
    });
    expect(scalarRun.events[1]?.actions.stateDelta['done']).toBe(true);
    expect(scalarRun.storedState['done']).toBe(true);
  });

  it('preserves a newly started streaming Task when stop_streaming awaits cancellation in parallel', async () => {
    let releaseNewStream: (() => void) | undefined;
    const monitorFeed = new FunctionTool({
      name: 'monitorFeed',
      description: 'streams feed updates until released',
      parameters: z.object({feedId: z.string()}),
      execute: async function* ({feedId}) {
        yield `feed:${feedId}`;
        await new Promise<void>((resolve) => {
          releaseNewStream = resolve;
        });
      },
    });
    const stopStreaming = new FunctionTool({
      name: 'stop_streaming',
      description: 'stops an active streaming tool',
      parameters: z.object({function_name: z.string()}),
      execute: async () => ({}),
    });

    const previousTask = new Task<void>(async (abortSignal) => {
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
          queueMicrotask(resolve);
          return;
        }
        abortSignal.addEventListener('abort', () => queueMicrotask(resolve), {
          once: true,
        });
      });
    });

    const agent = new LlmAgent({
      name: 'liveStreamGuardAgent',
      model: 'gemini-flash-latest',
      tools: [monitorFeed, stopStreaming],
    });
    const liveRequestQueue = new LiveRequestQueue();
    const invocationContext = new InvocationContext({
      invocationId: 'inv-stop-restart',
      agent,
      session: createSession({
        id: 'sess-stop-restart',
        appName: 'parallel-exec-app',
        userId: 'user-1',
      }),
      liveRequestQueue,
      activeStreamingTools: {
        monitorFeed: new ActiveStreamingTool({task: previousTask}),
      },
      pluginManager: new PluginManager(),
    });

    try {
      const mergedEvent = await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: createEvent({
          invocationId: invocationContext.invocationId,
          author: agent.name,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc-stop',
                  name: 'stop_streaming',
                  args: {function_name: 'monitorFeed'},
                },
              },
              {
                functionCall: {
                  id: 'fc-restart',
                  name: 'monitorFeed',
                  args: {feedId: 'feed-2'},
                },
              },
            ],
          },
        }),
        toolsDict: {
          monitorFeed,
          stop_streaming: stopStreaming,
        },
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });

      const currentTask =
        invocationContext.activeStreamingTools?.['monitorFeed']?.task;
      expect(previousTask.done()).toBe(true);
      expect(currentTask).toBeDefined();
      expect(currentTask).not.toBe(previousTask);
      expect(currentTask?.done()).toBe(false);
      expect(mergedEvent ? getFunctionResponses(mergedEvent) : []).toEqual([
        {
          id: 'fc-stop',
          name: 'stop_streaming',
          response: {
            status: 'Successfully stopped streaming function monitorFeed',
          },
        },
        {
          id: 'fc-restart',
          name: 'monitorFeed',
          response: {
            status:
              'The function is running asynchronously and the results are pending.',
          },
        },
      ]);
    } finally {
      releaseNewStream?.();
      invocationContext.activeStreamingTools?.['monitorFeed']?.task?.cancel();
      await invocationContext.activeStreamingTools?.['monitorFeed']?.task
        ?.promise;
      liveRequestQueue.close();
    }
  });

  it('retains the highest-stamped scalar value when parallel async tools update toolContext.state out of call order', async () => {
    let markSecondWritten: (() => void) | undefined;
    const secondWritten = new Promise<void>((resolve) => {
      markSecondWritten = resolve;
    });

    const incrementCounter = new FunctionTool({
      name: 'incrementCounter',
      description: 'increments a shared scalar counter in state',
      parameters: z.object({stepTag: z.string()}),
      execute: async ({stepTag}, toolContext) => {
        if (stepTag === 'slowFirst') {
          let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              secondWritten,
              new Promise<void>((resolve) => {
                fallbackTimer = setTimeout(resolve, 50);
              }),
            ]);
          } finally {
            clearTimeout(fallbackTimer);
          }
        }
        const current = toolContext?.state.get<number>('counter') ?? 0;
        toolContext?.state.set('counter', current + 1);
        markSecondWritten?.();
        return {stepTag};
      },
    });

    const {events, storedState} = await runParallelTurn({
      tools: [incrementCounter],
      functionCalls: [
        {
          id: 'fc-slow',
          name: 'incrementCounter',
          args: {stepTag: 'slowFirst'},
        },
        {
          id: 'fc-fast',
          name: 'incrementCounter',
          args: {stepTag: 'fastSecond'},
        },
      ],
      initialState: {counter: 0},
    });

    const mergedDelta = events[1]?.actions.stateDelta ?? {};
    expect(mergedDelta['counter']).toBe(2);
    expect(storedState['counter']).toBe(2);
    expect(getDeltaWriteStamp(mergedDelta, 'counter')).toBeTypeOf('number');
    expect(getDeltaWriteStamp(mergedDelta, 'unstampedKey')).toBeUndefined();

    const session = createSession({
      id: 'sess-stamp-check',
      appName: 'parallel-exec-app',
      userId: 'user-1',
    });
    expect(getStateWriteStamp(session.state, 'counter')).toBeUndefined();
    const ctx = new InvocationContext({
      invocationId: 'inv-stamp-check',
      agent: new LlmAgent({
        name: 'stampCheckAgent',
        model: 'gemini-flash-latest',
        tools: [incrementCounter],
      }),
      session,
      pluginManager: new PluginManager(),
    });
    const toolCtx = new Context({invocationContext: ctx});
    toolCtx.state.set('counter', 7);
    expect(getStateWriteStamp(session.state, 'counter')).toBe(
      getDeltaWriteStamp(toolCtx.actions.stateDelta, 'counter'),
    );

    const setStampedThenDirect = new FunctionTool({
      name: 'setStampedThenDirect',
      description: 'writes either via state or directly to stateDelta',
      parameters: z.object({mode: z.enum(['stamped', 'direct'])}),
      execute: async ({mode}, currentToolContext) => {
        if (mode === 'stamped') {
          currentToolContext?.state.set('counter', 10);
        } else if (currentToolContext) {
          currentToolContext.actions.stateDelta['counter'] = 99;
        }
        return {mode};
      },
    });

    const mixedRun = await runParallelTurn({
      tools: [setStampedThenDirect],
      functionCalls: [
        {
          id: 'fc-stamped',
          name: 'setStampedThenDirect',
          args: {mode: 'stamped'},
        },
        {
          id: 'fc-direct',
          name: 'setStampedThenDirect',
          args: {mode: 'direct'},
        },
      ],
    });

    const mixedDelta = mixedRun.events[1]?.actions.stateDelta ?? {};
    expect(mixedDelta['counter']).toBe(99);
    expect(mixedRun.storedState['counter']).toBe(99);
    expect(getDeltaWriteStamp(mixedDelta, 'counter')).toBeUndefined();
  });

  it('restores the latest stamped state write when an intermediate unstamped stateDelta write is overwritten by a later stamped call', async () => {
    let markOlderWritten: (() => void) | undefined;
    const olderWritten = new Promise<void>((resolve) => {
      markOlderWritten = resolve;
    });
    let invocationSession: Session | undefined;

    const mixedThreeWayTool = new FunctionTool({
      name: 'mixedThreeWayTool',
      description:
        'writes scalar, array, and plain-object keys across stamped and unstamped paths',
      parameters: z.object({
        callRole: z.enum(['latestStamped', 'unstampedMiddle', 'olderStamped']),
      }),
      execute: async ({callRole}, toolContext) => {
        if (!toolContext) {
          return {callRole};
        }
        invocationSession = toolContext.invocationContext.session;
        if (callRole === 'latestStamped') {
          let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              olderWritten,
              new Promise<void>((resolve) => {
                fallbackTimer = setTimeout(resolve, 50);
              }),
            ]);
          } finally {
            clearTimeout(fallbackTimer);
          }
          toolContext.state.set('score', 2);
          const existingItems = toolContext.state.get<string[]>('items') ?? [];
          toolContext.state.set('items', [...existingItems, 'a']);
          const existingDoc = toolContext.state.get<{tags: string[]}>('doc');
          toolContext.state.set('doc', {
            tags: [...(existingDoc?.tags ?? []), 'a'],
          });
          toolContext.state.set('scalarOverPlain', 'latest');
          toolContext.state.set('config', {shared: 'fromFirst', firstOnly: 1});
          return {callRole};
        }

        if (callRole === 'unstampedMiddle') {
          toolContext.actions.stateDelta['score'] = 50;
          toolContext.actions.stateDelta['items'] = ['direct'];
          toolContext.actions.stateDelta['doc'] = ['directDoc'];
          toolContext.actions.stateDelta['scalarOverPlain'] = {direct: true};
          toolContext.actions.stateDelta['config'] = {
            shared: 'directOverride',
          };
          return {callRole};
        }

        toolContext.state.set('score', 1);
        toolContext.state.set('items', ['c']);
        toolContext.state.set('doc', {tags: ['c']});
        toolContext.state.set('scalarOverPlain', 'older');
        toolContext.state.set('config', {thirdOnly: 3});
        markOlderWritten?.();
        return {callRole};
      },
    });

    const {events, storedState} = await runParallelTurn({
      tools: [mixedThreeWayTool],
      functionCalls: [
        {
          id: 'fc-1',
          name: 'mixedThreeWayTool',
          args: {callRole: 'latestStamped'},
        },
        {
          id: 'fc-2',
          name: 'mixedThreeWayTool',
          args: {callRole: 'unstampedMiddle'},
        },
        {
          id: 'fc-3',
          name: 'mixedThreeWayTool',
          args: {callRole: 'olderStamped'},
        },
      ],
    });

    const mergedDelta = events[1]?.actions.stateDelta ?? {};
    const liveState = invocationSession?.state ?? {};

    expect(mergedDelta['score']).toBe(2);
    expect(liveState['score']).toBe(2);
    expect(storedState['score']).toBe(2);
    expect(getDeltaWriteStamp(mergedDelta, 'score')).toBe(
      getStateWriteStamp(liveState, 'score'),
    );

    expect(mergedDelta['items']).toEqual(['c', 'a']);
    expect(liveState['items']).toEqual(['c', 'a']);
    expect(storedState['items']).toEqual(['c', 'a']);

    expect(mergedDelta['doc']).toEqual({tags: ['c', 'a']});
    expect(liveState['doc']).toEqual({tags: ['c', 'a']});
    expect(storedState['doc']).toEqual({tags: ['c', 'a']});

    expect(mergedDelta['scalarOverPlain']).toBe('latest');
    expect(liveState['scalarOverPlain']).toBe('latest');
    expect(storedState['scalarOverPlain']).toBe('latest');

    const expectedConfig = {
      shared: 'directOverride',
      firstOnly: 1,
      thirdOnly: 3,
    };
    expect(mergedDelta['config']).toEqual(expectedConfig);
    expect(liveState['config']).toEqual(expectedConfig);
    expect(storedState['config']).toEqual(expectedConfig);
  });

  it('ignores inherited Object.prototype keys in plain object maps during function call handling', async () => {
    expect(
      getLongRunningFunctionCalls(
        [{id: 'fc-proto', name: 'toString', args: {}}],
        {testTool},
      ).size,
    ).toBe(0);

    let seenConfirmation: unknown = 'unset';
    let seenResumeInputs: Record<string, unknown> | undefined;
    const inspectContextTool = new FunctionTool({
      name: 'inspectContextTool',
      description: 'captures confirmation and resume inputs from toolContext',
      parameters: z.object({}),
      execute: (_args, toolContext) => {
        seenConfirmation = toolContext?.toolConfirmation;
        seenResumeInputs = toolContext?.resumeInputs;
        return {ok: true};
      },
    });
    const stopStreaming = new FunctionTool({
      name: 'stop_streaming',
      description: 'stops an active streaming tool',
      parameters: z.object({function_name: z.string()}),
      execute: async () => ({}),
    });

    const agent = new LlmAgent({
      name: 'protoGuardAgent',
      model: 'gemini-flash-latest',
      tools: [inspectContextTool, stopStreaming],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-proto-guard',
      agent,
      session: createSession({
        id: 'sess-proto-guard',
        appName: 'parallel-exec-app',
        userId: 'user-1',
      }),
      activeStreamingTools: {},
      pluginManager: new PluginManager(),
    });

    const responseEvent = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'constructor', name: 'inspectContextTool', args: {}},
      ],
      toolsDict: {inspectContextTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
      toolConfirmationDict: {},
      resumeInputsDict: {},
    });

    expect(responseEvent).not.toBeNull();
    expect(seenConfirmation).toBeUndefined();
    expect(seenResumeInputs).toEqual({});

    const stopProtoEvent = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent: createEvent({
        invocationId: invocationContext.invocationId,
        author: agent.name,
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-stop-proto',
                name: 'stop_streaming',
                args: {function_name: 'constructor'},
              },
            },
          ],
        },
      }),
      toolsDict: {stop_streaming: stopStreaming},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(stopProtoEvent ? getFunctionResponses(stopProtoEvent) : []).toEqual([
      {
        id: 'fc-stop-proto',
        name: 'stop_streaming',
        response: {
          status: 'No active streaming function named constructor found',
        },
      },
    ]);
  });

  it('awaits in-flight sibling tools before rejecting when a tool callback throws in a parallel batch', async () => {
    // 1. Direct `handleFunctionCallsAsync` call: rejects with the first
    //    callback error only after the in-flight sibling tool settles.
    let markDirectSiblingInFlight: (() => void) | undefined;
    const directSiblingInFlight = new Promise<void>((resolve) => {
      markDirectSiblingInFlight = resolve;
    });
    let releaseDirectSibling: (() => void) | undefined;
    const allowDirectSiblingToFinish = new Promise<void>((resolve) => {
      releaseDirectSibling = resolve;
    });
    let directSiblingFinished = false;

    const directSiblingTool = new FunctionTool({
      name: 'directSiblingTool',
      description: 'updates session state after awaiting an async step',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        markDirectSiblingInFlight?.();
        await allowDirectSiblingToFinish;
        toolContext?.state.set('directSiblingWrite', 'settledBeforeRejection');
        directSiblingFinished = true;
        return {result: 'siblingDone'};
      },
    });
    const directFailingBeforeTool = new FunctionTool({
      name: 'directFailingBeforeTool',
      description: 'never executes because beforeToolCallback throws',
      parameters: z.object({}),
      execute: async () => ({result: 'unreachable'}),
    });
    const directFailingAfterTool = new FunctionTool({
      name: 'directFailingAfterTool',
      description: 'executes before afterToolCallback throws',
      parameters: z.object({}),
      execute: () => ({result: 'fastDone'}),
    });

    const directAgent = new LlmAgent({
      name: 'directCallbackRejectionAgent',
      model: 'gemini-flash-latest',
      tools: [
        directSiblingTool,
        directFailingBeforeTool,
        directFailingAfterTool,
      ],
    });
    const directSession = createSession({
      id: 'sess-direct-reject',
      appName: 'parallel-exec-app',
      userId: 'user-1',
    });
    const directContext = new InvocationContext({
      invocationId: 'inv-direct-reject',
      agent: directAgent,
      session: directSession,
      pluginManager: new PluginManager(),
    });

    let caughtError: unknown;
    let stateAtRejection: Record<string, unknown> = {};
    try {
      await handleFunctionCallsAsync({
        invocationContext: directContext,
        functionCallEvent: createEvent({
          invocationId: directContext.invocationId,
          author: directAgent.name,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc-direct-1',
                  name: 'directSiblingTool',
                  args: {},
                },
              },
              {
                functionCall: {
                  id: 'fc-direct-2',
                  name: 'directFailingBeforeTool',
                  args: {},
                },
              },
              {
                functionCall: {
                  id: 'fc-direct-3',
                  name: 'directFailingAfterTool',
                  args: {},
                },
              },
            ],
          },
        }),
        toolsDict: {
          directSiblingTool,
          directFailingBeforeTool,
          directFailingAfterTool,
        },
        beforeToolCallbacks: [
          async ({tool}) => {
            if (tool.name === 'directFailingBeforeTool') {
              await directSiblingInFlight;
              setTimeout(() => {
                releaseDirectSibling?.();
              }, 0);
              throw new Error('Before-tool callback failed.');
            }
            return undefined;
          },
        ],
        afterToolCallbacks: [
          async ({tool}) => {
            if (tool.name === 'directFailingAfterTool') {
              await directSiblingInFlight;
              throw new Error('After-tool callback failed.');
            }
            return undefined;
          },
        ],
      });
    } catch (e: unknown) {
      caughtError = e;
      stateAtRejection = {...directSession.state};
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError instanceof Error ? caughtError.message : '').toBe(
      'Before-tool callback failed.',
    );
    expect(directSiblingFinished).toBe(true);
    expect(stateAtRejection).toEqual({
      directSiblingWrite: 'settledBeforeRejection',
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(directSession.state).toEqual(stateAtRejection);

    // 2. Full `Runner.runAsync` lifecycle: `BaseToolset.close()` in `Runner`'s
    //    `finally` runs only after the sibling async tool finishes.
    class TrackingToolset extends BaseToolset {
      closed = false;

      constructor(private readonly resolveTools: () => BaseTool[]) {
        super();
      }

      override async getTools(): Promise<BaseTool[]> {
        return this.resolveTools();
      }

      override async close(): Promise<void> {
        this.closed = true;
      }
    }

    let markRunnerSiblingInFlight: (() => void) | undefined;
    const runnerSiblingInFlight = new Promise<void>((resolve) => {
      markRunnerSiblingInFlight = resolve;
    });
    let releaseRunnerSibling: (() => void) | undefined;
    const allowRunnerSiblingToFinish = new Promise<void>((resolve) => {
      releaseRunnerSibling = resolve;
    });

    let runnerSiblingFinished = false;
    let toolsetClosedDuringSibling = false;
    let runnerInvocationState: Record<string, unknown> | undefined;
    const trackingToolset = new TrackingToolset(() => [
      siblingAsyncTool,
      failingBeforeTool,
    ]);

    const siblingAsyncTool = new FunctionTool({
      name: 'siblingAsyncTool',
      description: 'updates session state before runner tears down toolsets',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        runnerInvocationState = toolContext?.invocationContext.session.state;
        markRunnerSiblingInFlight?.();
        await allowRunnerSiblingToFinish;
        toolsetClosedDuringSibling = trackingToolset.closed;
        toolContext?.state.set('siblingWrite', 'settledBeforeClose');
        runnerSiblingFinished = true;
        return {result: 'siblingDone'};
      },
    });
    const failingBeforeTool = new FunctionTool({
      name: 'failingBeforeTool',
      description: 'never executes because beforeToolCallback throws',
      parameters: z.object({}),
      execute: async () => ({result: 'unreachable'}),
    });

    const appName = 'parallel-exec-app';
    const userId = 'user-1';
    const mockLlm = new RecordingResponsesLlm([
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'fc-1', name: 'siblingAsyncTool', args: {}}},
            {functionCall: {id: 'fc-2', name: 'failingBeforeTool', args: {}}},
          ],
        },
      },
    ]);
    const agent = new LlmAgent({
      name: 'callbackRejectionAgent',
      model: mockLlm,
      tools: [trackingToolset],
      beforeToolCallback: async ({tool}) => {
        if (tool.name === 'failingBeforeTool') {
          await runnerSiblingInFlight;
          setTimeout(() => {
            releaseRunnerSibling?.();
          }, 0);
          throw new Error('Runner before-tool callback failed.');
        }
        return undefined;
      },
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({appName, userId});
    const runner = new Runner({appName, agent, sessionService});

    const emittedEvents: Event[] = [];
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'run parallel tools'}]},
    })) {
      emittedEvents.push(event);
    }
    const stateAfterRun = {...runnerInvocationState};

    expect(emittedEvents.at(-1)?.errorMessage).toBe(
      'Runner before-tool callback failed.',
    );
    expect(runnerSiblingFinished).toBe(true);
    expect(toolsetClosedDuringSibling).toBe(false);
    expect(trackingToolset.closed).toBe(true);
    expect(stateAfterRun).toEqual({
      siblingWrite: 'settledBeforeClose',
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(runnerInvocationState).toEqual(stateAfterRun);
  });
});

describe('live streaming generator cleanup and sequential function calls', () => {
  it('awaits return(undefined) once when tool._callLive next() rejects before settling task.promise', async () => {
    class RejectingLiveStreamTool extends BaseTool {
      readonly execute = async function* (): AsyncGenerator<
        unknown,
        void,
        unknown
      > {
        yield* [];
      };
      returnFinished = false;
      readonly returnSpy = vi.fn(
        async (): Promise<IteratorResult<unknown, void>> => {
          await Promise.resolve();
          this.returnFinished = true;
          return {value: undefined, done: true};
        },
      );

      constructor() {
        super({
          name: 'rejectingStreamTool',
          description: 'rejects from _callLive next()',
        });
      }

      override async runAsync(): Promise<unknown> {
        return {};
      }

      _callLive(): AsyncGenerator<unknown, void, unknown> {
        return {
          next: async () => {
            throw new Error('live stream next failed');
          },
          return: this.returnSpy,
          throw: async (error: unknown) => {
            throw error;
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      }
    }

    const tool = new RejectingLiveStreamTool();
    const agent = new LlmAgent({
      name: 'liveStreamCleanupAgent',
      model: 'gemini-flash-latest',
      tools: [tool],
    });
    const liveRequestQueue = new LiveRequestQueue();
    const invocationContext = new InvocationContext({
      invocationId: 'inv-live-next-reject',
      agent,
      session: createSession({
        id: 'sess-live-next-reject',
        appName: 'live-stream-app',
        userId: 'user-1',
      }),
      liveRequestQueue,
      pluginManager: new PluginManager(),
    });

    await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent: createEvent({
        invocationId: invocationContext.invocationId,
        author: agent.name,
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-reject-1',
                name: 'rejectingStreamTool',
                args: {},
              },
            },
          ],
        },
      }),
      toolsDict: {rejectingStreamTool: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const activeTask =
      invocationContext.activeStreamingTools?.['rejectingStreamTool']?.task;
    expect(activeTask).toBeDefined();
    await expect(activeTask?.promise).rejects.toThrow(
      'live stream next failed',
    );
    expect(tool.returnFinished).toBe(true);
    expect(tool.returnSpy).toHaveBeenCalledTimes(1);
    expect(tool.returnSpy).toHaveBeenCalledWith(undefined);
    liveRequestQueue.close();
  });

  it('awaits generator cleanup before rejecting task.promise when liveRequestQueue.sendContent throws', async () => {
    let cleanupFinished = false;
    const streamTool = new FunctionTool({
      name: 'queueFailureStream',
      description: 'streams values into a closed queue',
      parameters: z.object({}),
      execute: async function* () {
        try {
          yield 'chunk-1';
          yield 'chunk-2';
        } finally {
          await Promise.resolve();
          cleanupFinished = true;
        }
      },
    });

    const agent = new LlmAgent({
      name: 'queueFailureAgent',
      model: 'gemini-flash-latest',
      tools: [streamTool],
    });
    const liveRequestQueue = new LiveRequestQueue();
    const sendSpy = vi
      .spyOn(liveRequestQueue, 'sendContent')
      .mockImplementation(() => {
        throw new Error('live queue is closed');
      });
    try {
      const invocationContext = new InvocationContext({
        invocationId: 'inv-queue-throw',
        agent,
        session: createSession({
          id: 'sess-queue-throw',
          appName: 'live-stream-app',
          userId: 'user-1',
        }),
        liveRequestQueue,
        pluginManager: new PluginManager(),
      });

      await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: createEvent({
          invocationId: invocationContext.invocationId,
          author: agent.name,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc-queue-1',
                  name: 'queueFailureStream',
                  args: {},
                },
              },
            ],
          },
        }),
        toolsDict: {queueFailureStream: streamTool},
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });

      const activeTask =
        invocationContext.activeStreamingTools?.['queueFailureStream']?.task;
      expect(activeTask).toBeDefined();
      let cleanupStateAtReject = false;
      await expect(
        activeTask?.promise.catch((err: unknown) => {
          cleanupStateAtReject = cleanupFinished;
          throw err;
        }),
      ).rejects.toThrow('live queue is closed');
      expect(cleanupStateAtReject).toBe(true);
      expect(cleanupFinished).toBe(true);
    } finally {
      sendSpy.mockRestore();
      liveRequestQueue.close();
    }
  });

  it('settles stop_streaming promptly while a generator awaits, runs finally on resolution, and suppresses post-cancel yields', async () => {
    let releasePendingStep: (() => void) | undefined;
    let generatorFinalized = false;
    let reachedSubsequentStep = false;
    const streamTool = new FunctionTool({
      name: 'cancellableMetricStream',
      description: 'yields a sample and suspends on an external promise',
      parameters: z.object({}),
      execute: async function* () {
        try {
          yield 'sample-1';
          await new Promise<void>((resolve) => {
            releasePendingStep = resolve;
          });
          yield 'sample-2';
          reachedSubsequentStep = true;
          yield 'sample-3';
        } finally {
          generatorFinalized = true;
        }
      },
    });
    const stopStreamingTool = new FunctionTool({
      name: 'stop_streaming',
      description: 'stops an active streaming tool',
      parameters: z.object({function_name: z.string()}),
      execute: async () => ({}),
    });

    const agent = new LlmAgent({
      name: 'stopStreamCleanupAgent',
      model: 'gemini-flash-latest',
      tools: [streamTool, stopStreamingTool],
    });
    const liveRequestQueue = new LiveRequestQueue();
    const forwardedTexts: string[] = [];
    const originalSendContent =
      liveRequestQueue.sendContent.bind(liveRequestQueue);
    const sendSpy = vi
      .spyOn(liveRequestQueue, 'sendContent')
      .mockImplementation((content: Content) => {
        const text = content.parts?.[0]?.text;
        if (text !== undefined) {
          forwardedTexts.push(text);
        }
        originalSendContent(content);
      });

    try {
      const invocationContext = new InvocationContext({
        invocationId: 'inv-stop-cleanup',
        agent,
        session: createSession({
          id: 'sess-stop-cleanup',
          appName: 'live-stream-app',
          userId: 'user-1',
        }),
        liveRequestQueue,
        pluginManager: new PluginManager(),
      });

      await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: createEvent({
          invocationId: invocationContext.invocationId,
          author: agent.name,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc-start-stream',
                  name: 'cancellableMetricStream',
                  args: {},
                },
              },
            ],
          },
        }),
        toolsDict: {
          cancellableMetricStream: streamTool,
          stop_streaming: stopStreamingTool,
        },
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });

      const firstMessage = await liveRequestQueue.get();
      expect(firstMessage.content?.parts?.[0]?.text).toBe(
        'Function cancellableMetricStream returned: sample-1',
      );
      expect(generatorFinalized).toBe(false);

      const stopEvent = await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: createEvent({
          invocationId: invocationContext.invocationId,
          author: agent.name,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc-stop-stream',
                  name: 'stop_streaming',
                  args: {function_name: 'cancellableMetricStream'},
                },
              },
            ],
          },
        }),
        toolsDict: {
          cancellableMetricStream: streamTool,
          stop_streaming: stopStreamingTool,
        },
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });

      expect(stopEvent ? getFunctionResponses(stopEvent) : []).toEqual([
        {
          id: 'fc-stop-stream',
          name: 'stop_streaming',
          response: {
            status:
              'Successfully stopped streaming function cancellableMetricStream',
          },
        },
      ]);
      expect(generatorFinalized).toBe(false);

      releasePendingStep?.();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(generatorFinalized).toBe(true);
      expect(reachedSubsequentStep).toBe(false);
      expect(forwardedTexts).toEqual([
        'Function cancellableMetricStream returned: sample-1',
      ]);
    } finally {
      sendSpy.mockRestore();
      liveRequestQueue.close();
    }
  });

  it('accumulates conversation history across three sequential FunctionTool calls in Runner.runAsync', async () => {
    class CapturingSequentialLlm extends BaseLlm {
      readonly capturedContents: Content[][] = [];
      private turnIndex = 0;

      constructor(private readonly responses: LlmResponse[]) {
        super({model: 'gemini-flash-latest'});
      }

      override async *generateContentAsync(
        llmRequest: LlmRequest,
      ): AsyncGenerator<LlmResponse, void, void> {
        this.capturedContents.push(structuredClone(llmRequest.contents));
        const response = this.responses[this.turnIndex];
        this.turnIndex += 1;
        if (response) {
          yield response;
        }
      }

      override async connect(): Promise<BaseLlmConnection> {
        throw new Error('Live connection is not exercised in this test.');
      }
    }

    let callCount = 0;
    const increaseByOne = new FunctionTool({
      name: 'increaseByOne',
      description: 'Increments x by one.',
      parameters: z.object({x: z.number()}),
      execute: ({x}) => {
        callCount += 1;
        return x + 1;
      },
    });

    const model = new CapturingSequentialLlm([
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'fc-1', name: 'increaseByOne', args: {x: 1}}},
          ],
        },
      },
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'fc-2', name: 'increaseByOne', args: {x: 2}}},
          ],
        },
      },
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'fc-3', name: 'increaseByOne', args: {x: 3}}},
          ],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'response1'}],
        },
      },
    ]);

    const agent = new LlmAgent({
      name: 'rootAgent',
      model,
      tools: [increaseByOne],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'sequential-tools-app',
      userId: 'user-1',
    });
    const runner = new Runner({
      appName: 'sequential-tools-app',
      agent,
      sessionService,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'test'}]},
    })) {
      events.push(event);
    }

    expect(callCount).toBe(3);
    expect(events).toHaveLength(7);
    expect(
      events.map((event) => ({
        author: event.author,
        call: getFunctionCalls(event)[0]?.args,
        response: getFunctionResponses(event)[0]?.response,
        text: event.content?.parts?.[0]?.text,
      })),
    ).toEqual([
      {author: 'rootAgent', call: {x: 1}, response: undefined, text: undefined},
      {
        author: 'rootAgent',
        call: undefined,
        response: {result: 2},
        text: undefined,
      },
      {author: 'rootAgent', call: {x: 2}, response: undefined, text: undefined},
      {
        author: 'rootAgent',
        call: undefined,
        response: {result: 3},
        text: undefined,
      },
      {author: 'rootAgent', call: {x: 3}, response: undefined, text: undefined},
      {
        author: 'rootAgent',
        call: undefined,
        response: {result: 4},
        text: undefined,
      },
      {
        author: 'rootAgent',
        call: undefined,
        response: undefined,
        text: 'response1',
      },
    ]);

    expect(model.capturedContents.map((items) => items.length)).toEqual([
      1, 3, 5, 7,
    ]);
    expect(model.capturedContents[3]?.map((content) => content.role)).toEqual([
      'user',
      'model',
      'user',
      'model',
      'user',
      'model',
      'user',
    ]);
  });
});
