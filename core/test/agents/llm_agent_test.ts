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
import {Content} from '@google/genai';

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
