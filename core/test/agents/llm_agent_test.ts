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
  createEvent,
  Event,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  Session,
} from '@google/adk';
import {Content, Schema, Type} from '@google/genai';
import {z} from 'zod';
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

class MultiStepMockLlm extends BaseLlm {
  private readonly responses: LlmResponse[];
  private callCount = 0;

  constructor(responses: LlmResponse[]) {
    super({model: 'mock-llm'});
    this.responses = responses;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.responses[this.callCount++];
    if (response) {
      yield response;
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

class TransferTargetAgent extends LlmAgent {
  private readonly responseText: string;

  constructor(name: string, responseText: string) {
    super({name});
    this.responseText = responseText;
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: this.responseText}]},
    });
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

describe('LlmAgent tool streaming postprocess', () => {
  function buildInvocationContext(agent: LlmAgent): InvocationContext {
    return new InvocationContext({
      invocationId: 'inv_tools',
      session: {
        id: 'sess_tools',
        state: {
          hasDelta: () => false,
          get: () => undefined,
          set: () => {},
        },
        events: [],
      } as unknown as Session,
      agent,
      pluginManager: new PluginManager(),
    });
  }

  it('yields individual tool responses before confirmation event', async () => {
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'requests confirmation',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.requestConfirmation({hint: 'approve toolA'});
        return {result: 'A'};
      },
    });

    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'normal tool',
      parameters: z.object({}),
      execute: async () => ({result: 'B'}),
    });

    const llmResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
        ],
      },
    };

    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm(llmResponse),
      tools: [toolA, toolB],
    });
    const invocationContext = buildInvocationContext(agent);
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxConcurrentToolCalls: 2,
      maxLlmCalls: 500,
    };

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    const functionResponseEvents = events.filter(
      (event) => event.content?.parts?.[0]?.functionResponse,
    );
    expect(functionResponseEvents).toHaveLength(2);
    expect(
      functionResponseEvents.every(
        (event) => event.content?.parts?.length === 1,
      ),
    ).toBe(true);

    const confirmationEventIndex = events.findIndex((event) =>
      event.content?.parts?.some(
        (part) =>
          part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      ),
    );
    expect(confirmationEventIndex).toBeGreaterThan(-1);

    const lastFunctionResponseIndex = events.reduce((lastIndex, event, idx) => {
      return event.content?.parts?.[0]?.functionResponse ? idx : lastIndex;
    }, -1);
    expect(confirmationEventIndex).toBeGreaterThan(lastFunctionResponseIndex);
  });

  it('uses merged transferToAgent (last input tool wins) after streamed tool responses', async () => {
    const transferSlow = new FunctionTool({
      name: 'transferSlow',
      description: 'slow transfer setter',
      parameters: z.object({}),
      execute: async (_args, context) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        context!.actions.transferToAgent = 'agent_a';
        return {result: 'slow'};
      },
    });
    const transferFast = new FunctionTool({
      name: 'transferFast',
      description: 'fast transfer setter',
      parameters: z.object({}),
      execute: async (_args, context) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        context!.actions.transferToAgent = 'agent_b';
        return {result: 'fast'};
      },
    });

    const llmResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-slow', name: 'transferSlow', args: {}}},
          {functionCall: {id: 'id-fast', name: 'transferFast', args: {}}},
        ],
      },
    };

    const childA = new TransferTargetAgent('agent_a', 'from A');
    const childB = new TransferTargetAgent('agent_b', 'from B');

    const root = new LlmAgent({
      name: 'root_agent',
      model: new MockLlm(llmResponse),
      tools: [transferSlow, transferFast],
      subAgents: [childA, childB],
    });

    const invocationContext = buildInvocationContext(root);
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };

    const events: Event[] = [];
    for await (const event of root.runAsync(invocationContext)) {
      events.push(event);
    }

    const transferredAgentEvent = events.find(
      (event) =>
        event.author === 'agent_b' &&
        event.content?.parts?.some((part) => part.text === 'from B'),
    );
    expect(transferredAgentEvent).toBeDefined();
  });

  it('yields streamed tool responses before merged auth event', async () => {
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'requests auth',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.requestCredential({
          authScheme: {type: 'apiKey', in: 'header', name: 'x-api-key'},
          credentialKey: 'toolA-key',
        });
        return {result: 'A'};
      },
    });

    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'normal tool',
      parameters: z.object({}),
      execute: async () => ({result: 'B'}),
    });

    const llmResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
        ],
      },
    };

    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm(llmResponse),
      tools: [toolA, toolB],
    });
    const invocationContext = buildInvocationContext(agent);
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxConcurrentToolCalls: 2,
      maxLlmCalls: 500,
    };

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    const functionResponseEvents = events.filter(
      (event) => event.content?.parts?.[0]?.functionResponse,
    );
    expect(functionResponseEvents).toHaveLength(2);

    const authEventIndex = events.findIndex((event) =>
      event.content?.parts?.some(
        (part) => part.functionCall?.name === 'adk_request_credential',
      ),
    );
    expect(authEventIndex).toBeGreaterThan(-1);

    const lastFunctionResponseIndex = events.reduce((lastIndex, event, idx) => {
      return event.content?.parts?.[0]?.functionResponse ? idx : lastIndex;
    }, -1);
    expect(authEventIndex).toBeGreaterThan(lastFunctionResponseIndex);
  });

  async function buildInvocationContextWithSession(agent: LlmAgent): Promise<{
    ctx: InvocationContext;
    sessionService: InMemorySessionService;
    sessionId: string;
  }> {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });
    const ctx = new InvocationContext({
      invocationId: 'inv_sentinel',
      session,
      agent,
      pluginManager: new PluginManager(),
      sessionService,
    });
    return {ctx, sessionService, sessionId: session.id};
  }

  it('does not dispatch tools when pauseOnToolCalls is set', async () => {
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'normal tool',
      parameters: z.object({}),
      execute: async () => ({result: 'A'}),
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'normal tool',
      parameters: z.object({}),
      execute: async () => ({result: 'B'}),
    });
    const llmResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
        ],
      },
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm(llmResponse),
      tools: [toolA, toolB],
    });
    const invocationContext = buildInvocationContext(agent);
    invocationContext.runConfig = {
      parallelToolExecution: true,
      pauseOnToolCalls: true,
      maxLlmCalls: 500,
    };

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    // Only the model event with function calls is yielded; no tool responses
    const functionResponseEvents = events.filter((e) =>
      e.content?.parts?.some((p) => p.functionResponse),
    );
    expect(functionResponseEvents).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.some((p) => p.functionCall)).toBe(true);
  });

  it('completion sentinel is appended to session but not yielded in event stream', async () => {
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'tool A',
      parameters: z.object({}),
      execute: async () => ({result: 'A'}),
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'tool B',
      parameters: z.object({}),
      execute: async () => ({result: 'B'}),
    });
    const llmResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
        ],
      },
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm(llmResponse),
      tools: [toolA, toolB],
    });
    const {ctx, sessionService, sessionId} =
      await buildInvocationContextWithSession(agent);
    ctx.runConfig = {parallelToolExecution: true, maxLlmCalls: 500};

    const yieldedEvents: Event[] = [];
    for await (const event of agent.runAsync(ctx)) {
      yieldedEvents.push(event);
    }

    // No yielded event should carry the internal sentinel metadata
    const sentinelInYield = yieldedEvents.some(
      (e) => e.actions?.customMetadata?.['parallelToolBatchCompletion'],
    );
    expect(sentinelInYield).toBe(false);

    // Session must contain the sentinel
    const session = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId,
    });
    const sentinelInSession = session!.events.some(
      (e) => e.actions?.customMetadata?.['parallelToolBatchCompletion'],
    );
    expect(sentinelInSession).toBe(true);
  });

  it('single tool call does not append a completion sentinel to session', async () => {
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'tool A',
      parameters: z.object({}),
      execute: async () => ({result: 'A'}),
    });
    const llmResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'id-a', name: 'toolA', args: {}}}],
      },
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm(llmResponse),
      tools: [toolA],
    });
    const {ctx, sessionService, sessionId} =
      await buildInvocationContextWithSession(agent);
    ctx.runConfig = {parallelToolExecution: true, maxLlmCalls: 500};

    for await (const _ of agent.runAsync(ctx)) {
      // consume
    }

    const session = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId,
    });
    const hasSentinel = session!.events.some(
      (e) => e.actions?.customMetadata?.['parallelToolBatchCompletion'],
    );
    expect(hasSentinel).toBe(false);
  });

  it('outer loop calls LLM again after parallel tool batch completes', async () => {
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'tool A',
      parameters: z.object({}),
      execute: async () => ({result: 'A done'}),
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'tool B',
      parameters: z.object({}),
      execute: async () => ({result: 'B done'}),
    });
    // Step 1: model emits 2 parallel function calls
    const step1Response: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
        ],
      },
    };
    // Step 2: model returns a final text answer
    const step2Response: LlmResponse = {
      content: {role: 'model', parts: [{text: 'final answer'}]},
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MultiStepMockLlm([step1Response, step2Response]),
      tools: [toolA, toolB],
    });
    const invocationContext = buildInvocationContext(agent);
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    // Expect both tool responses streamed from step 1
    const functionResponseEvents = events.filter((e) =>
      e.content?.parts?.some((p) => p.functionResponse),
    );
    expect(functionResponseEvents).toHaveLength(2);

    // Expect final text event produced by step 2 LLM call
    const finalTextEvent = events.find((e) =>
      e.content?.parts?.some((p) => p.text === 'final answer'),
    );
    expect(finalTextEvent).toBeDefined();
  });
});
