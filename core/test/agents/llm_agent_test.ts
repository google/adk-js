/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  AUTH_PREPROCESSOR,
  BaseLlm,
  BaseLlmConnection,
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
  BasePlugin,
  BaseTool,
  BaseToolset,
  BuiltInPlanner,
  CONTENT_REQUEST_PROCESSOR,
  Context,
  ContextCompactorRequestProcessor,
  createEvent,
  createRunConfig,
  createSession,
  Event,
  FunctionTool,
  InMemorySessionService,
  INTERACTIONS_REQUEST_PROCESSOR,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  PlanReActPlanner,
  PluginManager,
  ReadonlyContext,
  RunAsyncToolRequest,
  Runner,
  Session,
  SkillToolset,
  StreamingMode,
  ToolProcessLlmRequest,
} from '@google/adk';
import {Content, Modality, Schema, Type} from '@google/genai';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/agent_transfer_llm_request_processor.js';
import {BASIC_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/basic_llm_request_processor.js';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  responseProcessor as CODE_EXECUTION_RESPONSE_PROCESSOR,
} from '../../src/agents/processors/code_execution_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/instructions_llm_request_processor.js';
import {
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
} from '../../src/agents/processors/nl_planning_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/request_confirmation_llm_request_processor.js';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/request_input_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from '../../src/agents/processors/tool_filter_request_processor.js';
import {logger} from '../../src/utils/logger.js';

class MockLlmConnection implements BaseLlmConnection {
  sendHistory(_history: Content[]): Promise<void> {
    return Promise.resolve();
  }
  sendContent(_content: Content): Promise<void> {
    return Promise.resolve();
  }
  sendRealtime(_blob: {data: string; mimeType: string}): Promise<void> {
    return Promise.resolve();
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    // No-op for mock.
  }
  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class MockLlm extends BaseLlm {
  response: LlmResponse | null;
  error: Error | null;

  constructor(response: LlmResponse | null, error: Error | null = null) {
    super({model: 'mock-llm'});
    this.response = response;
    this.error = error;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (this.error) {
      throw this.error;
    }
    if (this.response) {
      yield this.response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

class StreamingMockLlm extends BaseLlm {
  responseChunks: LlmResponse[];

  constructor(chunks: LlmResponse[]) {
    super({model: 'streaming-mock-llm'});
    this.responseChunks = chunks;
  }

  async *generateContentAsync(
    _request: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void, void> {
    for (const chunk of this.responseChunks) {
      if (abortSignal?.aborted) {
        return;
      }
      yield chunk;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

/**
 * Yields the chunks of `turns[n]` on the n-th call and counts how many turns
 * the agent asked for.
 */
class CountingMockLlm extends BaseLlm {
  callCount = 0;

  constructor(private readonly turns: LlmResponse[][]) {
    super({model: 'counting-mock-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield* this.turns[this.callCount++] ?? [];
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

class MockPlugin extends BasePlugin {
  beforeModelResponse?: LlmResponse;
  afterModelResponse?: LlmResponse;
  onModelErrorResponse?: LlmResponse;

  override async beforeModelCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return this.beforeModelResponse;
  }

  override async afterModelCallback(_params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return this.afterModelResponse;
  }

  override async onModelErrorCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return this.onModelErrorResponse;
  }
}

class MockRequestProcessor extends BaseLlmRequestProcessor {
  async *runAsync(
    _invocationContext: InvocationContext,
    _llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({id: 'evt_processor_1', author: 'processor'});
    yield createEvent({id: 'evt_processor_2', author: 'processor'});
  }
}

class MockTool extends BaseTool {
  constructor(
    name: string,
    private controller?: AbortController,
  ) {
    super({name, description: 'mock tool'});
  }
  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    return Promise.resolve({});
  }
  override async processLlmRequest(
    _params: ToolProcessLlmRequest,
  ): Promise<void> {
    if (this.controller) {
      this.controller.abort();
    }
  }
}

class MockToolWithRun extends BaseTool {
  constructor(
    name: string,
    private controller?: AbortController,
  ) {
    super({name, description: 'mock tool with run'});
  }
  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    if (this.controller) {
      this.controller.abort();
    }
    return Promise.resolve({result: 'success'});
  }
  override async processLlmRequest(
    params: ToolProcessLlmRequest,
  ): Promise<void> {
    params.llmRequest.toolsDict[this.name] = this;
  }
}

class MockResponseProcessor extends BaseLlmResponseProcessor {
  async *runAsync(
    _invocationContext: InvocationContext,
    _llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({id: 'evt_response_processor_1', author: 'processor'});
    yield createEvent({id: 'evt_response_processor_2', author: 'processor'});
  }
}

/**
 * A test subclass of LlmAgent to expose protected methods for testing.
 */
class TestLlmAgent extends LlmAgent {
  /** Publicly expose callLlmAsync for testing. */
  async *testCallLlmAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    modelResponseEvent: Event,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield* this.callLlmAsync(invocationContext, llmRequest, modelResponseEvent);
  }

  /** Publicly expose runAndHandleError for testing. */
  async *testRunAndHandleError<T extends LlmResponse | Event>(
    responseGenerator: AsyncGenerator<T, void, void>,
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    modelResponseEvent: Event,
  ): AsyncGenerator<T, void, void> {
    yield* this.runAndHandleError(
      responseGenerator,
      invocationContext,
      llmRequest,
      modelResponseEvent,
    );
  }
}

describe('LlmAgent.callLlm', () => {
  let agent: TestLlmAgent;
  let invocationContext: InvocationContext;
  let llmRequest: LlmRequest;
  let modelResponseEvent: Event;
  let pluginManager: PluginManager;
  let mockPlugin: MockPlugin;

  const originalLlmResponse: LlmResponse = {
    content: {parts: [{text: 'original'}]},
  };
  const beforePluginResponse: LlmResponse = {
    content: {parts: [{text: 'before plugin'}]},
  };
  const beforeCallbackResponse: LlmResponse = {
    content: {parts: [{text: 'before callback'}]},
  };
  const afterPluginResponse: LlmResponse = {
    content: {parts: [{text: 'after plugin'}]},
  };
  const afterCallbackResponse: LlmResponse = {
    content: {parts: [{text: 'after callback'}]},
  };
  const onModelErrorPluginResponse: LlmResponse = {
    content: {parts: [{text: 'on model error plugin'}]},
  };
  const modelError = new Error(
    JSON.stringify({
      error: {
        message: 'LLM error',
        code: 500,
      },
    }),
  );

  beforeEach(() => {
    mockPlugin = new MockPlugin('mock_plugin');
    pluginManager = new PluginManager();
    agent = new TestLlmAgent({name: 'test_agent'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent: agent,
      pluginManager,
    });
    llmRequest = {contents: [], liveConnectConfig: {}, toolsDict: {}};
    modelResponseEvent = {id: 'evt_123'} as Event;
  });

  async function callLlmUnderTest(): Promise<LlmResponse[]> {
    const responses: LlmResponse[] = [];
    const responseGenerator = agent.testCallLlmAsync(
      invocationContext,
      llmRequest,
      modelResponseEvent,
    );

    for await (const response of agent.testRunAndHandleError(
      responseGenerator,
      invocationContext,
      llmRequest,
      modelResponseEvent,
    )) {
      responses.push(response);
    }
    return responses;
  }

  it('short circuits when before model plugin callback returns a response', async () => {
    pluginManager.registerPlugin(mockPlugin);
    mockPlugin.beforeModelResponse = beforePluginResponse;
    const result = await callLlmUnderTest();
    expect(result).toEqual([beforePluginResponse]);
  });

  it('uses canonical before model callback when plugin returns undefined', async () => {
    agent.beforeModelCallback = async () => beforeCallbackResponse;
    const result = await callLlmUnderTest();
    expect(result).toEqual([beforeCallbackResponse]);
  });

  it('uses plugin after model callback to override response', async () => {
    pluginManager.registerPlugin(mockPlugin);
    agent.model = new MockLlm(originalLlmResponse);
    mockPlugin.afterModelResponse = afterPluginResponse;
    const result = await callLlmUnderTest();
    expect(result).toEqual([afterPluginResponse]);
  });

  it('uses canonical after model callback when plugin returns undefined', async () => {
    agent.afterModelCallback = async () => afterCallbackResponse;
    agent.model = new MockLlm(originalLlmResponse);
    const result = await callLlmUnderTest();
    expect(result).toEqual([afterCallbackResponse]);
  });

  it('uses plugin on model error callback to handle LLM error', async () => {
    pluginManager.registerPlugin(mockPlugin);
    agent.model = new MockLlm(null, modelError);
    mockPlugin.onModelErrorResponse = onModelErrorPluginResponse;
    const result = await callLlmUnderTest();
    expect(result).toEqual([onModelErrorPluginResponse]);
  });

  it('propagates LLM error message when no plugin callback is present', async () => {
    agent.model = new MockLlm(null, modelError);
    const result = await callLlmUnderTest();
    expect(result).toEqual([{errorCode: '500', errorMessage: 'LLM error'}]);
  });
});

describe('LlmAgent Schema Initialization', () => {
  it('should initialize inputSchema from Schema object', () => {
    const inputSchema: Schema = {
      type: Type.OBJECT,
      properties: {foo: {type: Type.STRING}},
    };
    const agent = new LlmAgent({name: 'test', inputSchema});
    expect(agent.inputSchema).toEqual(inputSchema);
  });

  it('should initialize inputSchema from Zod v4 object', () => {
    const zodSchema = z4.object({foo: z4.string()});
    const agent = new LlmAgent({
      name: 'test',
      inputSchema: zodSchema,
    });
    expect(agent.inputSchema).toBeDefined();
    expect((agent.inputSchema as Schema).type).toBe('OBJECT');
    expect((agent.inputSchema as Schema).properties?.foo?.type).toBe('STRING');
  });

  it('should initialize inputSchema from Zod v3 object', () => {
    const zodSchema = z3.object({
      foo: z3.string(),
    });
    const agent = new LlmAgent({
      name: 'test',
      inputSchema: zodSchema,
    });
    expect(agent.inputSchema).toBeDefined();
    expect((agent.inputSchema as Schema).type).toBe('OBJECT');
    expect((agent.inputSchema as Schema).properties?.foo?.type).toBe('STRING');
  });

  it('should initialize outputSchema from Schema object', () => {
    const outputSchema: Schema = {
      type: Type.OBJECT,
      properties: {bar: {type: Type.NUMBER}},
    };
    const agent = new LlmAgent({name: 'test', outputSchema});
    expect(agent.outputSchema).toEqual(outputSchema);
  });

  it('should initialize outputSchema from Zod z4 object', () => {
    const zodSchema = z4.object({bar: z4.number()});
    const agent = new LlmAgent({
      name: 'test',
      outputSchema: zodSchema,
    });
    expect(agent.outputSchema).toBeDefined();
    expect((agent.outputSchema as Schema).type).toBe('OBJECT');
    expect((agent.outputSchema as Schema).properties?.bar?.type).toBe('NUMBER');
  });

  it('validates output against a genai outputSchema', () => {
    const agent = new LlmAgent({
      name: 'test',
      outputSchema: {
        type: Type.OBJECT,
        properties: {bar: {type: Type.NUMBER}},
        required: ['bar'],
      },
    });
    expect(agent.validateOutput({bar: 1})).toEqual({bar: 1});
    expect(() => agent.validateOutput({bar: 'no'})).toThrow();
  });

  it('validates output against a Zod outputSchema, keeping its refinements', () => {
    const agent = new LlmAgent({
      name: 'test',
      outputSchema: z4.object({bar: z4.number().refine((n) => n > 10)}),
    });
    expect(agent.validateOutput({bar: 11})).toEqual({bar: 11});
    // The refinement survives only because the original Zod schema is kept;
    // it has no representation in the converted genai Schema.
    expect(() => agent.validateOutput({bar: 1})).toThrow();
  });

  it('keeps the supplied schema alongside the converted genai form', () => {
    const zodSchema = z4.object({bar: z4.number()});
    const agent = new LlmAgent({name: 'test', outputSchema: zodSchema});
    expect(agent.outputSchemaSource).toBe(zodSchema);
    expect((agent.outputSchema as Schema).type).toBe('OBJECT');
  });

  it('should initialize outputSchema from Zod v3 object', () => {
    const zodSchema = z3.object({
      bar: z3.number(),
    });
    const agent = new LlmAgent({
      name: 'test',
      outputSchema: zodSchema,
    });
    expect(agent.outputSchema).toBeDefined();
    expect((agent.outputSchema as Schema).type).toBe('OBJECT');
    expect((agent.outputSchema as Schema).properties?.bar?.type).toBe('NUMBER');
  });

  it('should enforce transfer restrictions when outputSchema is present', () => {
    const outputSchema: Schema = {type: Type.OBJECT};
    const agent = new LlmAgent({
      name: 'test',
      outputSchema,
      disallowTransferToParent: false,
      disallowTransferToPeers: false,
    });
    expect(agent.disallowTransferToParent).toBe(true);
    expect(agent.disallowTransferToPeers).toBe(true);
  });

  it('warns about transfer only when transfer was asked for explicitly', () => {
    const outputSchema: Schema = {type: Type.OBJECT};
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const quiet = new LlmAgent({name: 'quiet', outputSchema});
    expect(warnSpy).not.toHaveBeenCalled();
    expect(quiet.disallowTransferToParent).toBe(true);
    expect(quiet.disallowTransferToPeers).toBe(true);

    new LlmAgent({
      name: 'loud',
      outputSchema,
      disallowTransferToPeers: false,
    });
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it('warns about transfer when outputSchema co-exists with subAgents', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new LlmAgent({
      name: 'parent',
      outputSchema: {type: Type.OBJECT},
      subAgents: [new LlmAgent({name: 'child'})],
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(agent.disallowTransferToPeers).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('LlmAgent Output Processing', () => {
  let agent: LlmAgent;
  let invocationContext: InvocationContext;
  let validationSchema: Schema;

  beforeEach(() => {
    validationSchema = {
      type: Type.OBJECT,
      properties: {
        answer: {type: Type.STRING},
      },
    };
    agent = new LlmAgent({
      name: 'test_agent',
      outputSchema: validationSchema,
      outputKey: 'result',
    });
    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
    });
  });

  it('should save parsed JSON output to state based on outputKey', async () => {
    const jsonOutput = JSON.stringify({answer: '42'});
    const response: LlmResponse = {
      content: {parts: [{text: jsonOutput}]},
    };
    agent.model = new MockLlm(response);

    const generator = agent.runAsync(invocationContext);
    const events: Event[] = [];
    for await (const event of generator) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent).toBeDefined();
    expect(lastEvent.content?.parts?.[0].text).toEqual(jsonOutput);
    expect(lastEvent.actions?.stateDelta).toBeDefined();
    expect(lastEvent.actions?.stateDelta?.['result']).toEqual({answer: '42'});
  });

  it('should not save output if invalid JSON', async () => {
    const invalidJson = '{answer: 42'; // Missing closing brace
    const response: LlmResponse = {
      content: {parts: [{text: invalidJson}]},
    };
    agent.model = new MockLlm(response);

    const generator = agent.runAsync(invocationContext);
    const events: Event[] = [];
    for await (const event of generator) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent.actions?.stateDelta?.['result']).toEqual(invalidJson);
  });

  it('keeps the parsed object in state when it violates the output schema', async () => {
    // Well-formed JSON, but `answer` is declared STRING. The violation is
    // logged rather than thrown, and state keeps the object the model
    // returned — a consumer of `outputKey` reads the same type either way.
    const response: LlmResponse = {
      content: {parts: [{text: JSON.stringify({answer: 42})}]},
    };
    agent.model = new MockLlm(response);

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent.actions?.stateDelta?.['result']).toEqual({answer: 42});
  });
});

describe('LlmAgent Configuration with contextCompactors', () => {
  it('does not add ContextCompactorRequestProcessor if contextCompactors is not provided', () => {
    const agent = new LlmAgent({name: 'test_agent'});
    const compactorProcessors = agent.requestProcessors.filter(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(compactorProcessors.length).toBe(0);
  });

  it('does not add ContextCompactorRequestProcessor if contextCompactors is empty array', () => {
    const agent = new LlmAgent({name: 'test_agent', contextCompactors: []});
    const compactorProcessors = agent.requestProcessors.filter(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(compactorProcessors.length).toBe(0);
  });

  it('does not add ContextCompactorRequestProcessor if custom requestProcessors are provided', () => {
    const mockCompactor = {
      shouldCompact: () => false,
      compact: () => {},
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      contextCompactors: [mockCompactor],
      requestProcessors: [], // custom processors
    });
    const compactorProcessors = agent.requestProcessors.filter(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(compactorProcessors.length).toBe(0);
  });

  it('adds ContextCompactorRequestProcessor immediately before CONTENT_REQUEST_PROCESSOR', () => {
    const mockCompactor = {
      shouldCompact: () => false,
      compact: () => {},
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      contextCompactors: [mockCompactor],
    });

    const processorIndex = agent.requestProcessors.findIndex(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(processorIndex).toBeGreaterThanOrEqual(0);

    // Ensure it was placed right before CONTENT_REQUEST_PROCESSOR
    const contentIndex = agent.requestProcessors.indexOf(
      CONTENT_REQUEST_PROCESSOR,
    );
    expect(contentIndex).toBe(processorIndex + 1);
  });
});

describe('LlmAgent Abort Handling', () => {
  it('should stop execution when abortSignal is aborted between steps', async () => {
    const responseChunks: LlmResponse[] = [
      {content: {parts: [{text: 'chunk 1'}]}},
      {content: {parts: [{text: 'chunk 2'}]}},
      {content: {parts: [{text: 'chunk 3'}]}},
      {content: {parts: [{text: 'chunk 4'}]}},
      {content: {parts: [{text: 'chunk 5'}]}},
    ];
    const mockModel = new StreamingMockLlm(responseChunks);
    const agent = new LlmAgent({name: 'test_agent', model: mockModel});

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const abortController = new AbortController();
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const firstResult = await generator.next();
    expect(firstResult.done).toBe(false);
    expect((firstResult.value as Event).content?.parts?.[0].text).toBe(
      'chunk 1',
    );

    abortController.abort();

    const secondResult = await generator.next();
    expect(secondResult.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during request processors', async () => {
    const mockProcessor = new MockRequestProcessor();
    const agent = new LlmAgent({
      name: 'test_agent',
      requestProcessors: [mockProcessor],
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const abortController = new AbortController();
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const firstResult = await generator.next();
    expect(firstResult.done).toBe(false);
    expect((firstResult.value as Event).author).toBe('processor');

    abortController.abort();

    const secondResult = await generator.next();
    expect(secondResult.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during tool processing', async () => {
    const abortController = new AbortController();
    const mockTool = new MockTool('mock_tool', abortController);
    const agent = new LlmAgent({
      name: 'test_agent',
      tools: [mockTool],
      model: new MockLlm(null),
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const result = await generator.next();
    expect(result.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during after model callback', async () => {
    const abortController = new AbortController();
    const mockModel = new MockLlm({
      content: {parts: [{text: 'mock response'}]},
    });
    const agent = new LlmAgent({
      name: 'test_agent',
      model: mockModel,
    });

    agent.afterModelCallback = async () => {
      abortController.abort();
      return undefined;
    };

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const result = await generator.next();
    expect(result.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during tool invocation', async () => {
    const abortController = new AbortController();
    const mockTool = new MockToolWithRun('mock_tool', abortController);

    const functionCallResponse: LlmResponse = {
      content: {
        parts: [
          {
            functionCall: {
              name: 'mock_tool',
              args: {},
            },
          },
        ],
      },
    };

    const mockModel = new MockLlm(functionCallResponse);
    const agent = new LlmAgent({
      name: 'test_agent',
      tools: [mockTool],
      model: mockModel,
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const firstResult = await generator.next();
    expect(firstResult.done).toBe(false);
    expect(
      (firstResult.value as Event).content?.parts?.[0].functionCall?.name,
    ).toBe('mock_tool');

    const secondResult = await generator.next();
    expect(secondResult.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during response processors', async () => {
    const mockProcessor = new MockResponseProcessor();
    const agent = new LlmAgent({
      name: 'test_agent',
      responseProcessors: [mockProcessor],
      model: new MockLlm({content: {parts: [{text: 'mock response'}]}}),
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const abortController = new AbortController();
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const firstResult = await generator.next();
    expect(firstResult.done).toBe(false);
    expect((firstResult.value as Event).author).toBe('processor');

    abortController.abort();

    const secondResult = await generator.next();
    expect(secondResult.done).toBe(true);
  });
});

describe('LlmAgent postprocess empty parts filtering', () => {
  it('should not yield an event when LLM response has empty parts array', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({
        content: {role: 'model', parts: []},
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 0,
          totalTokenCount: 10,
        },
        finishReason: 'STOP' as never,
        partial: false,
      }),
    });
    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent,
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });
});

describe('LlmAgent long running tool termination', () => {
  const startJobCall: LlmResponse = {
    content: {
      role: 'model',
      parts: [{functionCall: {name: 'startJob', args: {}, id: 'call_1'}}],
    },
  };
  const secondTurnText: LlmResponse = {
    content: {role: 'model', parts: [{text: 'second turn'}]},
  };

  function runAgent(model: BaseLlm, startJob: LongRunningFunctionTool) {
    const agent = new LlmAgent({name: 'test_agent', model, tools: [startJob]});
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: createSession({id: 'sess_123', appName: 'test_app'}),
      agent,
      pluginManager: new PluginManager(),
    });
    return agent.runAsync(invocationContext);
  }

  function createStartJobTool(mutate?: (toolContext: Context) => void) {
    return new LongRunningFunctionTool({
      name: 'startJob',
      description: 'starts a background job',
      execute: async (_args, toolContext) => {
        mutate?.(toolContext!);
        return undefined;
      },
    });
  }

  it('should stop the step loop after an actions-only event', async () => {
    const model = new CountingMockLlm([[startJobCall], [secondTurnText]]);
    const startJob = createStartJobTool((toolContext) => {
      toolContext.actions.skipSummarization = true;
    });

    const events: Event[] = [];
    for await (const event of runAgent(model, startJob)) {
      events.push(event);
    }

    expect(model.callCount).toBe(1);
    expect(
      events.some((event) =>
        event.content?.parts?.some((part) => part.text === 'second turn'),
      ),
    ).toBe(false);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.content).toBeUndefined();
    expect(lastEvent.actions.skipSummarization).toBe(true);
  });

  it('should keep running the step loop after a trailing empty chunk with default actions', async () => {
    const model = new CountingMockLlm([
      [startJobCall, {content: {role: 'model'}}],
      [secondTurnText],
    ]);

    const events: Event[] = [];
    for await (const event of runAgent(model, createStartJobTool())) {
      events.push(event);
    }

    expect(model.callCount).toBe(2);
    expect(events[events.length - 1].content?.parts?.[0].text).toBe(
      'second turn',
    );
  });
});

describe('LlmAgent Default Request Processors', () => {
  it('includes AUTH_PREPROCESSOR in default requestProcessors before CONTENT_REQUEST_PROCESSOR', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
    });
    expect(agent.requestProcessors).toContain(AUTH_PREPROCESSOR);
    const authIndex = agent.requestProcessors.indexOf(AUTH_PREPROCESSOR);
    const contentIndex = agent.requestProcessors.indexOf(
      CONTENT_REQUEST_PROCESSOR,
    );
    expect(authIndex).toBeLessThan(contentIndex);
  });
});

describe('LlmAgent outputSchema with tools', () => {
  const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

  const OUTPUT_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {answer: {type: Type.STRING}},
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Records the single request the agent builds so that all three gated sites
   * can be asserted against one run of the default processor chain.
   */
  class CapturingLlm extends BaseLlm {
    capturedRequest?: LlmRequest;

    async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.capturedRequest = request;
      yield {content: {role: 'model', parts: [{text: '{"answer": "42"}'}]}};
    }

    async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  async function captureRequest(options: {
    model: string;
    withTools: boolean;
  }): Promise<LlmRequest> {
    const llm = new CapturingLlm({model: options.model});
    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      instruction: 'Base instruction',
      outputSchema: OUTPUT_SCHEMA,
      tools: options.withTools
        ? [
            new FunctionTool({
              name: 'some_tool',
              description: 'A test tool',
              execute: () => 'result',
            }),
          ]
        : [],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: createSession({
        id: 'sess_123',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    for await (const _ of agent.runAsync(invocationContext)) {
      // Drain the run so that the request is fully built.
    }

    const request = llm.capturedRequest;
    if (!request) {
      expect.fail('the agent never called the model');
    }
    return request;
  }

  it('uses the native response schema on Vertex AI with a Gemini 2.0+ model', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    const request = await captureRequest({
      model: 'gemini-2.5-flash',
      withTools: true,
    });

    expect(request.config?.responseSchema).toBeDefined();
    expect(request.config?.responseMimeType).toBe('application/json');
    expect(request.toolsDict).not.toHaveProperty('set_model_response');
    expect(request.toolsDict).toHaveProperty('some_tool');
    expect(request.config?.systemInstruction).not.toContain(
      'set_model_response',
    );
  });

  it('uses the set_model_response workaround outside the Vertex AI variant', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const request = await captureRequest({
      model: 'gemini-2.5-flash',
      withTools: true,
    });

    expect(request.config?.responseSchema).toBeUndefined();
    expect(request.toolsDict).toHaveProperty('set_model_response');
    expect(request.toolsDict).toHaveProperty('some_tool');
    expect(request.config?.systemInstruction).toContain('set_model_response');
  });

  it('uses the set_model_response workaround on Vertex AI with a pre-2.0 model', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    const request = await captureRequest({
      model: 'gemini-1.5-pro',
      withTools: true,
    });

    expect(request.config?.responseSchema).toBeUndefined();
    expect(request.toolsDict).toHaveProperty('set_model_response');
    expect(request.config?.systemInstruction).toContain('set_model_response');
  });

  it.each(['true', undefined])(
    'uses the native response schema without tools when %s',
    async (vertexEnv) => {
      vi.stubEnv(VERTEX_ENV_VAR, vertexEnv);

      const request = await captureRequest({
        model: 'gemini-2.5-flash',
        withTools: false,
      });

      expect(request.config?.responseSchema).toBeDefined();
      expect(request.toolsDict).not.toHaveProperty('set_model_response');
      expect(request.config?.systemInstruction).not.toContain(
        'set_model_response',
      );
    },
  );

  it('persists state writes made in processLlmRequest across turns', async () => {
    class StateProbeTool extends BaseTool {
      constructor() {
        super({name: 'state_probe_tool', description: 'test probe'});
      }
      override _getDeclaration() {
        return {
          name: this.name,
          description: this.description,
          parameters: {type: Type.OBJECT, properties: {}},
        };
      }
      override async processLlmRequest(
        request: ToolProcessLlmRequest,
      ): Promise<void> {
        await super.processLlmRequest(request);
        const {toolContext} = request;
        const current = toolContext.state.get<number>('probe_counter') ?? 0;
        toolContext.state.set('probe_counter', current + 1);
      }
      async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
        return Promise.resolve({result: 'ok'});
      }
    }

    const tool = new StateProbeTool();
    const mockLlm = new MockLlm({
      content: {role: 'model', parts: [{text: 'Done'}]},
    });
    const agent = new LlmAgent({
      name: 'probe_agent',
      model: mockLlm,
      tools: [tool],
    });

    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
    });

    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });

    for await (const _event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Turn 1'}]},
    })) {
      // Consume the stream
    }

    const sessionAfterTurn1 = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });
    expect(sessionAfterTurn1?.state?.['probe_counter']).toBe(1);

    for await (const _event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Turn 2'}]},
    })) {
      // Consume the stream
    }

    const sessionAfterTurn2 = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });
    expect(sessionAfterTurn2?.state?.['probe_counter']).toBe(2);
  });

  it('calls BaseToolset.processLlmRequest before tool hooks and persists state writes across turns', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    onTestFinished(() => warnSpy.mockRestore());

    const callOrder: string[] = [];

    class OrderProbeTool extends BaseTool {
      constructor() {
        super({name: 'order_probe_tool', description: 'test order'});
      }
      override _getDeclaration() {
        return {
          name: this.name,
          description: this.description,
          parameters: {type: Type.OBJECT, properties: {}},
        };
      }
      override async processLlmRequest(
        request: ToolProcessLlmRequest,
      ): Promise<void> {
        await super.processLlmRequest(request);
        callOrder.push('tool');
      }
      async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
        return {result: 'ok'};
      }
    }

    class InstructionToolset extends BaseToolset {
      constructor() {
        super([]);
      }
      override async getTools(): Promise<BaseTool[]> {
        return [new OrderProbeTool()];
      }
      override async close(): Promise<void> {}
      override async processLlmRequest(
        toolContext: Context,
        llmRequest: LlmRequest,
      ): Promise<void> {
        callOrder.push('toolset');
        const count = toolContext.state.get<number>('toolset_counter') ?? 0;
        toolContext.state.set('toolset_counter', count + 1);
        llmRequest.config ??= {};
        llmRequest.config.systemInstruction = `${llmRequest.config.systemInstruction ?? ''}\n\nTOOLSET INSTRUCTION`;
      }
    }

    const seenInstructions: Array<string | undefined> = [];
    class RecordingLlm extends BaseLlm {
      constructor() {
        super({model: 'recording-llm'});
      }
      async *generateContentAsync(
        llmRequest: LlmRequest,
      ): AsyncGenerator<LlmResponse, void, void> {
        seenInstructions.push(
          llmRequest.config?.systemInstruction as string | undefined,
        );
        yield {content: {role: 'model', parts: [{text: 'ok'}]}};
      }
      async connect(): Promise<BaseLlmConnection> {
        return new MockLlmConnection();
      }
    }

    const skillToolset = new SkillToolset([
      {
        frontmatter: {name: 'demo', description: 'demo skill'},
        instructions: 'Do the demo.',
      },
    ]);

    const agent = new LlmAgent({
      name: 'a',
      model: new RecordingLlm(),
      instruction: 'Be brief.',
      tools: [new InstructionToolset(), skillToolset],
    });

    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
    });
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });

    for await (const _event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Turn 1'}]},
    })) {
      // Consume stream
    }

    expect(callOrder).toEqual(['toolset', 'tool']);
    expect(seenInstructions).toHaveLength(1);
    expect(seenInstructions[0]).toContain('TOOLSET INSTRUCTION');
    expect(seenInstructions[0]).toContain('<available_skills>');
    expect(seenInstructions[0]).toContain('<name>demo</name>');

    const sessionAfterTurn1 = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });
    expect(sessionAfterTurn1?.state?.['toolset_counter']).toBe(1);

    for await (const _event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Turn 2'}]},
    })) {
      // Consume stream
    }

    const sessionAfterTurn2 = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });
    expect(sessionAfterTurn2?.state?.['toolset_counter']).toBe(2);
  });
});

describe('LlmAgent usage metadata on content-less responses', () => {
  let agent: LlmAgent;
  let invocationContext: InvocationContext;

  beforeEach(() => {
    agent = new LlmAgent({name: 'usage_test_agent'});
    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };
    invocationContext = new InvocationContext({
      invocationId: 'inv_usage',
      session: {
        id: 'sess_usage',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent,
      pluginManager: new PluginManager(),
    });
  });

  async function runAndCollect(): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }
    return events;
  }

  // In SSE streaming, GeminiStreamingResponseAggregator.close() reports a turn's
  // token counts on a response with no content, because the turn's parts were
  // already yielded. Skipping it loses that turn's usage entirely, and the loss
  // is silent: downstream, "no usage reported" and "zero tokens used" are the
  // same value.
  it('emits an event for a response that carries only usage metadata', async () => {
    const response: LlmResponse = {
      usageMetadata: {
        promptTokenCount: 1234,
        candidatesTokenCount: 56,
        totalTokenCount: 1290,
      },
    };
    agent.model = new MockLlm(response);

    const events = await runAndCollect();

    expect(events.length).toBeGreaterThan(0);
    const usageEvent = events.find((e) => e.usageMetadata);
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.usageMetadata?.promptTokenCount).toEqual(1234);
    expect(usageEvent!.usageMetadata?.candidatesTokenCount).toEqual(56);
  });

  // The event must NOT carry an empty parts array. That is what poisoned
  // session history and made Vertex reject the following request with HTTP 400
  // (#21, #22); buildContents() skips events without `content.role`, so an
  // undefined content keeps the usage out of history while still delivering it.
  it('does not emit empty-parts content alongside the usage', async () => {
    const response: LlmResponse = {
      usageMetadata: {promptTokenCount: 10, totalTokenCount: 10},
    };
    agent.model = new MockLlm(response);

    const events = await runAndCollect();

    const usageEvent = events.find((e) => e.usageMetadata);
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.content?.parts).toBeUndefined();
    expect(usageEvent!.content?.role).toBeUndefined();
  });

  // Control: without usage metadata the guard must still skip, or the fix would
  // start emitting events for genuinely empty responses.
  it('still skips a response with neither content nor usage metadata', async () => {
    agent.model = new MockLlm({} as LlmResponse);

    const events = await runAndCollect();

    expect(events.find((e) => e.usageMetadata)).toBeUndefined();
  });

  it('does not call the parent model again after transfer_to_agent when a trailing usage-only chunk arrives in SSE mode', async () => {
    const usage = {
      promptTokenCount: 10,
      candidatesTokenCount: 2,
      totalTokenCount: 12,
    };
    const childModel = new CountingMockLlm([
      [
        {
          content: {role: 'model', parts: [{text: 'child answer'}]},
          partial: false,
        },
        {usageMetadata: usage},
      ],
    ]);
    const parentModel = new CountingMockLlm([
      [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'transfer_to_agent',
                  args: {agent_name: 'child'},
                },
              },
            ],
          },
        },
        {usageMetadata: usage},
      ],
      [
        {
          content: {role: 'model', parts: [{text: 'parent answers again'}]},
        },
      ],
    ]);

    const child = new LlmAgent({name: 'child', model: childModel});
    const parent = new LlmAgent({
      name: 'parent',
      subAgents: [child],
      model: parentModel,
    });

    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    const runner = new Runner({appName: 'app', agent: parent, sessionService});

    const texts: Array<[string | undefined, string]> = [];
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: 's',
      newMessage: {role: 'user', parts: [{text: 'hi'}]},
      runConfig: {streamingMode: StreamingMode.SSE},
    })) {
      for (const part of event.content?.parts ?? []) {
        if (part.text) {
          texts.push([event.author, part.text]);
        }
      }
    }

    expect(parentModel.callCount).toBe(1);
    expect(childModel.callCount).toBe(1);
    expect(texts).toEqual([['child', 'child answer']]);
  });
});

describe('LlmAgent unresolvable tool calls', () => {
  /**
   * Calls a name that cannot resolve, then reacts to whatever came back — the
   * behaviour a real model has and the stub in the bug report deliberately
   * lacks.
   */
  class GhostCallerLlm extends BaseLlm {
    calls = 0;

    constructor() {
      super({model: 'mock-llm'});
    }

    async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.calls++;
      const answered = (request.contents ?? []).some((content) =>
        (content.parts ?? []).some(
          (part) =>
            (part.functionResponse?.response as {error?: string} | undefined)
              ?.error,
        ),
      );
      yield answered
        ? {content: {role: 'model', parts: [{text: 'Recovered.'}]}}
        : {
            content: {
              role: 'model',
              parts: [
                {functionCall: {id: 'call-1', name: 'ghost_tool', args: {}}},
              ],
            },
          };
    }

    async connect(): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  // The unit tests cover `handleFunctionCallList` directly, but #789 is a
  // whole-invocation symptom: the throw reached `runAndHandleError`, the turn
  // reported UNKNOWN_ERROR, and the unanswered call was re-issued until
  // `maxLlmCalls` tripped. Assert it here so reintroducing the escape one
  // layer up cannot stay green.
  it('completes the invocation instead of erroring and re-issuing the call', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    onTestFinished(() => warnSpy.mockRestore());
    const mockLlm = new GhostCallerLlm();
    const agent = new LlmAgent({
      name: 'ghost_agent',
      model: mockLlm,
      tools: [
        new FunctionTool({
          name: 'real_tool',
          description: 'The only registered tool.',
          parameters: z3.object({}),
          execute: async () => ({result: 'ok'}),
        }),
      ],
    });

    const sessionService = new InMemorySessionService();
    const runner = new Runner({appName: 'test_app', agent, sessionService});
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      events.push(event);
    }

    // No error event: this is a tool failure the turn recovers from, not a
    // model error that fails the invocation.
    expect(events.filter((e) => e.errorMessage)).toHaveLength(0);
    expect(events.filter((e) => e.errorCode)).toHaveLength(0);

    // Two model calls, not `maxLlmCalls` worth.
    expect(mockLlm.calls).toBe(2);

    const parts = events.flatMap((e) => e.content?.parts ?? []);
    const calls = parts.filter((p) => p.functionCall);
    const responses = parts.filter((p) => p.functionResponse);
    // Gemini rejects a dangling functionCall, so the pairing has to balance.
    expect(calls).toHaveLength(1);
    expect(responses).toHaveLength(1);
    expect(responses[0].functionResponse!.id).toBe('call-1');
    expect(responses[0].functionResponse!.name).toBe('ghost_tool');
    expect(responses[0].functionResponse!.response).toHaveProperty('error');

    expect(parts.some((p) => p.text === 'Recovered.')).toBe(true);
  });
});

/**
 * Asserts that `actual` holds exactly the `expected` processor instances, in
 * order. `toEqual` is not enough: it ignores class types, so two stateless
 * processors compare equal.
 */
function expectSameInstances(actual: unknown[], expected: unknown[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((item, i) => expect(item).toBe(expected[i]));
}

describe('LlmAgent planning processor positions', () => {
  const DEFAULT_REQUEST_PROCESSORS = [
    BASIC_LLM_REQUEST_PROCESSOR,
    AUTH_PREPROCESSOR,
    IDENTITY_LLM_REQUEST_PROCESSOR,
    INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
    REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
    REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
    CONTENT_REQUEST_PROCESSOR,
    NL_PLANNING_REQUEST_PROCESSOR,
    INTERACTIONS_REQUEST_PROCESSOR,
    CODE_EXECUTION_REQUEST_PROCESSOR,
    TOOL_FILTER_REQUEST_PROCESSOR,
    AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
  ];

  it('places the planning request processor right after the content processor', () => {
    const agent = new LlmAgent({name: 'test_agent'});
    const processors = agent.requestProcessors;
    const planningIndex = processors.indexOf(NL_PLANNING_REQUEST_PROCESSOR);

    expect(processors[processors.indexOf(CONTENT_REQUEST_PROCESSOR) + 1]).toBe(
      NL_PLANNING_REQUEST_PROCESSOR,
    );
    expect(processors.indexOf(INTERACTIONS_REQUEST_PROCESSOR)).toBe(
      planningIndex + 1,
    );
    expectSameInstances(processors, DEFAULT_REQUEST_PROCESSORS);
  });

  it('keeps the compactor before the content processor', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      contextCompactors: [{shouldCompact: () => false, compact: () => {}}],
    });
    const processors = agent.requestProcessors;
    const contentIndex = processors.indexOf(CONTENT_REQUEST_PROCESSOR);

    expect(processors[contentIndex - 1]).toEqual(
      expect.any(ContextCompactorRequestProcessor),
    );
    expectSameInstances(
      processors.filter((_, i) => i !== contentIndex - 1),
      DEFAULT_REQUEST_PROCESSORS,
    );
  });

  it('uses the planning and code execution response processors as the defaults', () => {
    const agent = new LlmAgent({name: 'test_agent'});

    expectSameInstances(agent.responseProcessors, [
      NL_PLANNING_RESPONSE_PROCESSOR,
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    ]);
  });

  it('lets caller-supplied processor lists replace the defaults', () => {
    const requestProcessor = new MockRequestProcessor();
    const responseProcessor = new MockResponseProcessor();
    const agent = new LlmAgent({
      name: 'test_agent',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      planner: new PlanReActPlanner(),
      requestProcessors: [requestProcessor],
      responseProcessors: [responseProcessor],
    });

    expectSameInstances(agent.requestProcessors, [requestProcessor]);
    expectSameInstances(agent.responseProcessors, [responseProcessor]);
    expect(agent.requestProcessors).not.toContain(
      NL_PLANNING_REQUEST_PROCESSOR,
    );
    expect(agent.responseProcessors).not.toContain(
      NL_PLANNING_RESPONSE_PROCESSOR,
    );
  });
});

describe('LlmAgent planner configuration', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('stores the planner', () => {
    const planner = new PlanReActPlanner();
    const agent = new LlmAgent({name: 'test_agent', planner});

    expect(agent.planner).toBe(planner);
  });

  it('warns once when both thinking configs are set', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new BuiltInPlanner({thinkingConfig: {thinkingBudget: 1024}}),
      generateContentConfig: {thinkingConfig: {thinkingBudget: 0}},
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('test_agent');
    expect(warnSpy.mock.calls[0][0]).toContain('takes precedence');
    expect(agent.generateContentConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    });
  });

  it('does not warn when only the planner has a thinking config', () => {
    new LlmAgent({
      name: 'test_agent',
      planner: new BuiltInPlanner({thinkingConfig: {thinkingBudget: 1024}}),
      generateContentConfig: {temperature: 0.1},
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when only generateContentConfig has a thinking config', () => {
    new LlmAgent({
      name: 'test_agent',
      generateContentConfig: {thinkingConfig: {thinkingBudget: 0}},
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for a PlanReActPlanner with a thinking config', () => {
    new LlmAgent({
      name: 'test_agent',
      planner: new PlanReActPlanner(),
      generateContentConfig: {thinkingConfig: {thinkingBudget: 0}},
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('LlmAgent run with a planner', () => {
  /**
   * Snapshots every request it receives and yields a new response object on
   * each call, so that the planning response processor cannot leak state
   * between calls.
   */
  class PlanningCapturingLlm extends BaseLlm {
    capturedRequests: Array<Pick<LlmRequest, 'contents' | 'config'>> = [];

    constructor() {
      super({model: 'planning-capturing-llm'});
    }

    async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.capturedRequests.push(
        structuredClone({contents: request.contents, config: request.config}),
      );
      yield {
        content: {
          role: 'model',
          parts: [
            {text: '/*PLANNING*/1. answer'},
            {text: '/*REASONING*/simple/*FINAL_ANSWER*/42'},
          ],
        },
      };
    }

    async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  function createSeededSession(): Session {
    return createSession({
      id: 'sess_planner',
      appName: 'test-app',
      userId: 'test-user',
      events: [
        createEvent({
          invocationId: 'earlier',
          author: 'user',
          content: {role: 'user', parts: [{text: 'first question'}]},
        }),
        createEvent({
          invocationId: 'earlier',
          author: 'planner_agent',
          content: {
            role: 'model',
            parts: [
              {text: '/*PLANNING*/old plan', thought: true},
              {text: 'old answer'},
            ],
          },
        }),
        createEvent({
          invocationId: 'inv_planner',
          author: 'user',
          content: {role: 'user', parts: [{text: 'second question'}]},
        }),
      ],
    });
  }

  async function runAgent(agent: LlmAgent, session: Session): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of agent.runAsync(
      new InvocationContext({
        invocationId: 'inv_planner',
        session,
        agent,
        pluginManager: new PluginManager(),
      }),
    )) {
      events.push(event);
    }
    return events;
  }

  it('sends the BuiltInPlanner thinking config instead of generateContentConfig', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    onTestFinished(() => warnSpy.mockRestore());
    const llm = new PlanningCapturingLlm();
    const plannerThinkingConfig = {includeThoughts: true, thinkingBudget: 512};
    const agent = new LlmAgent({
      name: 'planner_agent',
      model: llm,
      planner: new BuiltInPlanner({thinkingConfig: plannerThinkingConfig}),
      generateContentConfig: {thinkingConfig: {thinkingBudget: 0}},
    });

    const events = await runAgent(agent, createSeededSession());

    expect(llm.capturedRequests).toHaveLength(1);
    expect(llm.capturedRequests[0].config?.thinkingConfig).toEqual(
      plannerThinkingConfig,
    );
    expect(agent.generateContentConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    });
    const modelEvent = events.find((e) => e.author === 'planner_agent');
    expect(modelEvent?.content?.parts).toEqual([
      {text: '/*PLANNING*/1. answer'},
      {text: '/*REASONING*/simple/*FINAL_ANSWER*/42'},
    ]);
  });

  it('runs a PlanReActPlanner end to end', async () => {
    const llm = new PlanningCapturingLlm();
    const planner = new PlanReActPlanner();
    const agent = new LlmAgent({
      name: 'planner_agent',
      model: llm,
      instruction: 'Answer questions.',
      planner,
    });
    const session = createSeededSession();

    const events = await runAgent(agent, session);

    expect(llm.capturedRequests).toHaveLength(1);
    const request = llm.capturedRequests[0];
    const planningInstruction = planner.buildPlanningInstruction(
      new ReadonlyContext(
        new InvocationContext({
          invocationId: 'inv_planner',
          session,
          agent,
          pluginManager: new PluginManager(),
        }),
      ),
      {contents: [], toolsDict: {}, liveConnectConfig: {}},
    );
    expect(request.config?.systemInstruction).toContain('Answer questions.');
    expect(request.config?.systemInstruction).toContain(planningInstruction);

    const requestParts = request.contents.flatMap((c) => c.parts ?? []);
    expect(requestParts.some((p) => p.text === '/*PLANNING*/old plan')).toBe(
      true,
    );
    for (const part of requestParts) {
      expect(part).not.toHaveProperty('thought');
    }
    expect(session.events[1].content?.parts?.[0]).toEqual({
      text: '/*PLANNING*/old plan',
      thought: true,
    });

    const modelEvent = events.find((e) => e.author === 'planner_agent');
    expect(modelEvent?.content?.parts).toEqual([
      {text: '/*PLANNING*/1. answer', thought: true},
      {text: '/*REASONING*/simple/*FINAL_ANSWER*/', thought: true},
      {text: '42'},
    ]);
  });
});

describe('LlmAgent live streaming tools and supportCfc', () => {
  class ScriptedLiveConnection extends MockLlmConnection {
    sentContents: Content[] = [];
    sentBlobs: Array<{data: string; mimeType: string}> = [];
    closed = false;
    private yielded = false;

    constructor(private readonly responses: LlmResponse[]) {
      super();
    }

    override async sendContent(content: Content): Promise<void> {
      this.sentContents.push(content);
    }

    override async sendRealtime(blob: {
      data: string;
      mimeType: string;
    }): Promise<void> {
      this.sentBlobs.push(blob);
    }

    override async *receive(): AsyncGenerator<LlmResponse, void, void> {
      if (this.closed || this.yielded) {
        return;
      }
      this.yielded = true;
      for (const response of this.responses) {
        if (this.closed) {
          return;
        }
        yield response;
      }
    }

    override async close(): Promise<void> {
      this.closed = true;
    }
  }

  class ScriptedLiveLlm extends BaseLlm {
    lastConnectedRequest?: LlmRequest;

    constructor(private readonly connection: ScriptedLiveConnection) {
      super({model: 'gemini-2.0-flash'});
    }

    async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
      yield* [];
      throw new Error('generateContentAsync should not be called in live/CFC');
    }

    async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      this.lastConnectedRequest = llmRequest;
      return this.connection;
    }
  }

  it('sets responseModalities to [Modality.TEXT], runs afterModelCallback, filters partial responses unless SSE, and closes queue on turnComplete when supportCfc is true', async () => {
    const connection = new ScriptedLiveConnection([
      {
        content: {role: 'model', parts: [{text: 'partial chunk'}]},
        partial: true,
      },
      {
        content: {role: 'model', parts: [{text: 'final cfc answer'}]},
        partial: false,
        turnComplete: true,
      },
    ]);
    const llm = new ScriptedLiveLlm(connection);
    const afterSeen: string[] = [];
    const agent = new LlmAgent({
      name: 'cfc_agent',
      model: llm,
      afterModelCallback: ({response}) => {
        const text = response.content?.parts?.[0]?.text;
        if (text) {
          afterSeen.push(text);
        }
        if (text === 'final cfc answer') {
          return {
            ...response,
            content: {
              role: 'model',
              parts: [{text: 'final cfc answer (callback)'}],
            },
          };
        }
        return undefined;
      },
    });
    const session = createSession({
      id: 'sess_cfc_none',
      appName: 'test-app',
      userId: 'test-user',
      events: [
        createEvent({
          invocationId: 'inv_cfc_none',
          author: 'user',
          content: {role: 'user', parts: [{text: 'run cfc'}]},
        }),
      ],
    });
    const ctx = new InvocationContext({
      invocationId: 'inv_cfc_none',
      session,
      agent,
      runConfig: createRunConfig({
        supportCfc: true,
        streamingMode: StreamingMode.NONE,
        responseModalities: [Modality.AUDIO],
      }),
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(ctx)) {
      events.push(event);
    }

    expect(
      llm.lastConnectedRequest?.liveConnectConfig?.responseModalities,
    ).toEqual([Modality.TEXT]);
    expect(afterSeen).toEqual(['partial chunk', 'final cfc answer']);
    expect(events).toHaveLength(1);
    expect(events[0].content?.parts).toEqual([
      {text: 'final cfc answer (callback)'},
    ]);
    expect(connection.closed).toBe(true);
  });

  it('yields partial events in callLlmAsync when supportCfc is true and streamingMode is SSE', async () => {
    const connection = new ScriptedLiveConnection([
      {
        content: {role: 'model', parts: [{text: 'sse partial'}]},
        partial: true,
      },
      {
        content: {role: 'model', parts: [{text: 'sse final'}]},
        partial: false,
        turnComplete: true,
      },
    ]);
    const llm = new ScriptedLiveLlm(connection);
    const agent = new LlmAgent({
      name: 'cfc_sse_agent',
      model: llm,
    });
    const session = createSession({
      id: 'sess_cfc_sse',
      appName: 'test-app',
      userId: 'test-user',
      events: [
        createEvent({
          invocationId: 'inv_cfc_sse',
          author: 'user',
          content: {role: 'user', parts: [{text: 'stream cfc'}]},
        }),
      ],
    });
    const ctx = new InvocationContext({
      invocationId: 'inv_cfc_sse',
      session,
      agent,
      runConfig: createRunConfig({
        supportCfc: true,
        streamingMode: StreamingMode.SSE,
      }),
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(ctx)) {
      events.push(event);
    }

    expect(
      events.map((e) => ({
        partial: e.partial,
        text: e.content?.parts?.[0]?.text,
      })),
    ).toEqual([
      {partial: true, text: 'sse partial'},
      {partial: false, text: 'sse final'},
    ]);
  });

  it('forwards liveRequestQueue items to activeStreamingTools streams and executes streaming tools in postprocessLive', async () => {
    const toolStream = new LiveRequestQueue();
    const streamTool = new FunctionTool({
      name: 'liveStreamTool',
      description: 'yields live updates',
      parameters: z4.object({topic: z4.string()}),
      execute: async function* ({topic}) {
        yield `update:${topic}`;
      },
    });
    const connection = new ScriptedLiveConnection([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-live-stream-1',
                name: 'liveStreamTool',
                args: {topic: 'weather'},
              },
            },
          ],
        },
      },
    ]);
    const llm = new ScriptedLiveLlm(connection);
    const agent = new LlmAgent({
      name: 'live_stream_agent',
      model: llm,
      tools: [streamTool],
    });
    const session = createSession({
      id: 'sess_live_stream',
      appName: 'test-app',
      userId: 'test-user',
    });
    const liveRequestQueue = new LiveRequestQueue();
    liveRequestQueue.sendRealtime({
      data: 'audio-bytes',
      mimeType: 'audio/pcm',
    });
    liveRequestQueue.close();

    const ctx = new InvocationContext({
      invocationId: 'inv_live_stream',
      session,
      agent,
      liveRequestQueue,
      activeStreamingTools: {
        existingListener: new ActiveStreamingTool({stream: toolStream}),
      },
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runLive(ctx)) {
      events.push(event);
    }

    const forwardedBlob = await toolStream.get();
    expect(forwardedBlob.blob).toEqual({
      data: 'audio-bytes',
      mimeType: 'audio/pcm',
    });

    const functionResponseEvent = events.find(
      (e) => e.content?.parts?.[0]?.functionResponse !== undefined,
    );
    expect(functionResponseEvent?.content?.parts).toEqual([
      {
        functionResponse: {
          id: 'fc-live-stream-1',
          name: 'liveStreamTool',
          response: {
            status:
              'The function is running asynchronously and the results are pending.',
          },
        },
      },
    ]);
  });

  it('executes a tool call and responseProcessors exactly once when supportCfc is true', async () => {
    const toolExecute = vi.fn().mockResolvedValue({sum: 7});
    const addTool = new FunctionTool({
      name: 'add_numbers',
      description: 'Adds two numbers',
      parameters: z4.object({a: z4.number(), b: z4.number()}),
      execute: toolExecute,
    });
    const connection = new ScriptedLiveConnection([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-cfc-1',
                name: 'add_numbers',
                args: {a: 3, b: 4},
              },
            },
          ],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'The sum is 7.'}],
        },
        turnComplete: true,
      },
    ]);
    const llm = new ScriptedLiveLlm(connection);
    let responseProcessorRuns = 0;
    class CountingResponseProcessor extends BaseLlmResponseProcessor {
      async *runAsync(): AsyncGenerator<Event, void, void> {
        responseProcessorRuns += 1;
        yield* [];
      }
    }
    const agent = new LlmAgent({
      name: 'cfc_tool_agent',
      model: llm,
      tools: [addTool],
      responseProcessors: [new CountingResponseProcessor()],
    });
    const session = createSession({
      id: 'sess_cfc_tool',
      appName: 'test-app',
      userId: 'test-user',
      events: [
        createEvent({
          invocationId: 'inv_cfc_tool',
          author: 'user',
          content: {role: 'user', parts: [{text: 'add 3 and 4'}]},
        }),
      ],
    });
    const ctx = new InvocationContext({
      invocationId: 'inv_cfc_tool',
      session,
      agent,
      runConfig: createRunConfig({
        supportCfc: true,
      }),
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(ctx)) {
      events.push(event);
    }

    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(toolExecute).toHaveBeenCalledWith({a: 3, b: 4}, expect.anything());
    expect(responseProcessorRuns).toBe(2);
    expect(events).toHaveLength(3);
    expect(events[0].content?.parts?.[0]?.functionCall?.name).toBe(
      'add_numbers',
    );
    expect(events[1].content?.parts?.[0]?.functionResponse?.response).toEqual({
      sum: 7,
    });
    expect(events[2].content?.parts?.[0]?.text).toBe('The sum is 7.');
  });

  it('enforces maxLlmCalls, preserves an existing liveRequestQueue, and closes the queue on early exit when supportCfc is true', async () => {
    const connection = new ScriptedLiveConnection([
      {
        content: {role: 'model', parts: [{text: 'first event'}]},
        partial: false,
      },
      {
        content: {role: 'model', parts: [{text: 'second event'}]},
        partial: false,
        turnComplete: true,
      },
    ]);
    const llm = new ScriptedLiveLlm(connection);
    const agent = new LlmAgent({
      name: 'cfc_lifecycle_agent',
      model: llm,
    });
    const session = createSession({
      id: 'sess_cfc_lifecycle',
      appName: 'test-app',
      userId: 'test-user',
      events: [
        createEvent({
          invocationId: 'inv_cfc_lifecycle',
          author: 'user',
          content: {role: 'user', parts: [{text: 'test lifecycle'}]},
        }),
      ],
    });
    const existingQueue = new LiveRequestQueue();
    const ctx = new InvocationContext({
      invocationId: 'inv_cfc_lifecycle',
      session,
      agent,
      liveRequestQueue: existingQueue,
      runConfig: createRunConfig({
        supportCfc: true,
        maxLlmCalls: 1,
      }),
      pluginManager: new PluginManager(),
    });

    // Break early after the first yielded event (before turnComplete).
    for await (const event of agent.runAsync(ctx)) {
      expect(event.content?.parts?.[0]?.text).toBe('first event');
      break;
    }

    expect(ctx.liveRequestQueue).toBe(existingQueue);
    expect(() =>
      existingQueue.sendContent({role: 'user', parts: [{text: 'late'}]}),
    ).toThrow(/Cannot send to a closed queue/);

    // A second call on the same context exceeds maxLlmCalls (1).
    const secondRunEvents: Event[] = [];
    for await (const event of agent.runAsync(ctx)) {
      secondRunEvents.push(event);
    }
    expect(secondRunEvents).toHaveLength(1);
    expect(secondRunEvents[0].errorMessage).toMatch(
      /Max number of llm calls limit of 1 exceeded/,
    );
  });

  it('calls BaseToolset.processLlmRequest before tool hooks in runLivePreprocess', async () => {
    const callOrder: string[] = [];

    class LiveProbeTool extends BaseTool {
      constructor() {
        super({name: 'live_probe_tool', description: 'live probe'});
      }
      override _getDeclaration() {
        return {
          name: this.name,
          description: this.description,
          parameters: {type: Type.OBJECT, properties: {}},
        };
      }
      override async processLlmRequest(
        request: ToolProcessLlmRequest,
      ): Promise<void> {
        await super.processLlmRequest(request);
        callOrder.push('tool');
      }
      async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
        return {result: 'ok'};
      }
    }

    class LiveInstructionToolset extends BaseToolset {
      constructor() {
        super([]);
      }
      override async getTools(): Promise<BaseTool[]> {
        return [new LiveProbeTool()];
      }
      override async close(): Promise<void> {}
      override async processLlmRequest(
        _toolContext: Context,
        llmRequest: LlmRequest,
      ): Promise<void> {
        callOrder.push('toolset');
        llmRequest.config ??= {};
        llmRequest.config.systemInstruction = `${llmRequest.config.systemInstruction ?? ''}\n\nLIVE TOOLSET INSTRUCTION`;
      }
    }

    const connection = new ScriptedLiveConnection([
      {
        content: {role: 'model', parts: [{text: 'live done'}]},
        turnComplete: true,
      },
    ]);
    const llm = new ScriptedLiveLlm(connection);
    const agent = new LlmAgent({
      name: 'live_toolset_agent',
      model: llm,
      instruction: 'Be brief.',
      tools: [new LiveInstructionToolset()],
    });
    const session = createSession({
      id: 'sess_live_toolset',
      appName: 'test-app',
      userId: 'test-user',
    });
    const liveRequestQueue = new LiveRequestQueue();
    liveRequestQueue.close();
    const ctx = new InvocationContext({
      invocationId: 'inv_live_toolset',
      session,
      agent,
      liveRequestQueue,
      pluginManager: new PluginManager(),
    });

    for await (const _event of agent.runLive(ctx)) {
      // Consume stream
    }

    expect(callOrder).toEqual(['toolset', 'tool']);
    expect(llm.lastConnectedRequest?.config?.systemInstruction).toContain(
      'LIVE TOOLSET INSTRUCTION',
    );
  });

  it('keeps one event id across partial chunks and final event of a streamed response, minting a fresh id only after a complete event', async () => {
    class MultiResponseLlm extends BaseLlm {
      constructor(private readonly responses: LlmResponse[]) {
        super({model: 'multi-response-llm'});
      }

      async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
        for (const response of this.responses) {
          yield response;
        }
      }

      async connect(): Promise<BaseLlmConnection> {
        return new MockLlmConnection();
      }
    }

    const llm = new MultiResponseLlm([
      {
        content: {role: 'model', parts: [{text: 'Hello '}]},
        partial: true,
      },
      {
        content: {role: 'model', parts: [{text: 'world!'}]},
        partial: true,
      },
      {
        content: {role: 'model', parts: [{text: 'Hello world!'}]},
        partial: false,
      },
      {
        content: {role: 'model', parts: [{text: 'Second distinct response'}]},
        partial: false,
      },
    ]);

    const agent = new LlmAgent({
      name: 'streaming_id_agent',
      model: llm,
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'sess_stream_ids',
    });
    const runner = new Runner({
      appName: 'test-app',
      agent,
      sessionService,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test-user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'stream please'}]},
      runConfig: createRunConfig({streamingMode: StreamingMode.SSE}),
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(4);
    expect(events[0].partial).toBe(true);
    expect(events[1].partial).toBe(true);
    expect(events[2].partial).toBe(false);
    expect(events[3].partial).toBe(false);

    // Partial chunks and the final complete event of the first response share one id.
    expect(events[1].id).toBe(events[0].id);
    expect(events[2].id).toBe(events[0].id);

    // A subsequent complete response gets a newly minted id.
    expect(events[3].id).not.toBe(events[0].id);

    // Stored session events match the complete event IDs.
    const reloadedSession = await sessionService.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: session.id,
    });
    const storedAgentEvents = reloadedSession!.events.filter(
      (e) => e.author === 'streaming_id_agent',
    );
    expect(storedAgentEvents.map((e) => e.id)).toEqual([
      events[0].id,
      events[3].id,
    ]);
  });
});
