/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  BaseLlm,
  BaseLlmConnection,
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
  BasePlugin,
  BaseTool,
  CONTENT_REQUEST_PROCESSOR,
  Context,
  ContextCompactorRequestProcessor,
  createEvent,
  createSession,
  Event,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  RunAsyncToolRequest,
  Runner,
  Session,
  ToolProcessLlmRequest,
} from '@google/adk';
import {Content, Schema, Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
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

  // In SSE streaming, StreamingResponseAggregator.close() reports a turn's
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
});
