/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  CallbackContext,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Session,
} from '@google/adk';
import {Content, Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

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

class MockPlugin extends BasePlugin {
  beforeModelResponse?: LlmResponse;
  afterModelResponse?: LlmResponse;
  onModelErrorResponse?: LlmResponse;

  override async beforeModelCallback(_params: {
    callbackContext: CallbackContext;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return this.beforeModelResponse;
  }

  override async afterModelCallback(_params: {
    callbackContext: CallbackContext;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return this.afterModelResponse;
  }

  override async onModelErrorCallback(_params: {
    callbackContext: CallbackContext;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return this.onModelErrorResponse;
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
});
