/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, BaseLlmConnection, BasePlugin, CallbackContext, Event, InvocationContext, LlmAgent, LlmRequest, LlmResponse, PluginManager, Session, SingleAfterModelCallback, SingleBeforeModelCallback,} from '@google/adk';
import {Content} from '@google/genai';

class MockLlmConnection implements BaseLlmConnection {
  sendHistory(history: Content[]): Promise<void> {
    return Promise.resolve();
  }
  sendContent(content: Content): Promise<void> {
    return Promise.resolve();
  }
  sendRealtime(blob: {
    data: string,
    mimeType: string,
  }): Promise<void> {
    return Promise.resolve();
  }
  async * receive(): AsyncGenerator<LlmResponse, void, void> {
    // No-op for mock.
  }
  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class MockLlm extends BaseLlm {
  response: LlmResponse|null;
  error: Error|null;

  constructor(response: LlmResponse|null, error: Error|null = null) {
    super('mock-llm');
    this.response = response;
    this.error = error;
  }

  async *
      generateContentAsync(request: LlmRequest):
          AsyncGenerator<LlmResponse, void, void> {
    if (this.error) {
      throw this.error;
    }
    if (this.response) {
      yield this.response;
    }
  }

  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

class MockPlugin extends BasePlugin {
  beforeModelResponse?: LlmResponse;
  afterModelResponse?: LlmResponse;
  onModelErrorResponse?: LlmResponse;

  override async beforeModelCallback(
      {callbackContext,
       llmRequest}: {callbackContext: CallbackContext, llmRequest: LlmRequest},
      ): Promise<LlmResponse|undefined> {
    return this.beforeModelResponse;
  }

  override async afterModelCallback(
      {callbackContext, llmResponse}:
          {callbackContext: CallbackContext, llmResponse: LlmResponse},
      ): Promise<LlmResponse|undefined> {
    return this.afterModelResponse;
  }

  override async onModelErrorCallback(
      {callbackContext, llmRequest, error}: {
        callbackContext: CallbackContext,
        llmRequest: LlmRequest,
        error: Error
      },
      ): Promise<LlmResponse|undefined> {
    return this.onModelErrorResponse;
  }
}

describe('LlmAgent.callLlm', () => {
  let agent: LlmAgent;
  let invocationContext: InvocationContext;
  let llmRequest: LlmRequest;
  let modelResponseEvent: Event;
  let pluginManager: PluginManager;
  let mockPlugin: MockPlugin;

  const originalLlmResponse:
      LlmResponse = {content: {parts: [{text: 'original'}]}};
  const beforePluginResponse:
      LlmResponse = {content: {parts: [{text: 'before plugin'}]}};
  const beforeCallbackResponse:
      LlmResponse = {content: {parts: [{text: 'before callback'}]}};
  const afterPluginResponse:
      LlmResponse = {content: {parts: [{text: 'after plugin'}]}};
  const afterCallbackResponse:
      LlmResponse = {content: {parts: [{text: 'after callback'}]}};
  const onModelErrorPluginResponse:
      LlmResponse = {content: {parts: [{text: 'on model error plugin'}]}};
  const modelError = new Error(JSON.stringify({
    error: {
      message: 'LLM error',
      code: 500,
    },
  }));

  beforeEach(() => {
    mockPlugin = new MockPlugin('mock_plugin');
    pluginManager = new PluginManager();
    agent = new LlmAgent({name: 'test_agent'});
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (
        const response of (agent as any)
            .callLlmAsync(invocationContext, llmRequest, modelResponseEvent)) {
      responses.push(response);
    }
    return responses;
  }

  // 1. No plugins and no callbacks configured.
  it('returns unaltered LLM response with no plugins or callbacks',
     async () => {
       agent.model = new MockLlm(originalLlmResponse);
       const responses = await callLlmUnderTest();
       expect(responses).toEqual([originalLlmResponse]);
     });

  // 2. Plugin beforeModelCallback short circuits.
  it('short circuits when before model plugin callback returns a response',
     async () => {
       mockPlugin.beforeModelResponse = beforePluginResponse;
       pluginManager.registerPlugin(mockPlugin);
       const beforeCallback: SingleBeforeModelCallback = async () =>
           beforeCallbackResponse;
       agent.beforeModelCallback = [beforeCallback];
       agent.model = new MockLlm(originalLlmResponse);
       const responses = await callLlmUnderTest();
       expect(responses).toEqual([beforePluginResponse]);
     });

  // 3. Plugin beforeModelCallback returns undefined, canonical callback used.
  it('uses canonical before model callback when plugin returns undefined',
     async () => {
       pluginManager.registerPlugin(mockPlugin);
       const beforeCallback: SingleBeforeModelCallback = async () =>
           beforeCallbackResponse;
       agent.beforeModelCallback = [beforeCallback];
       agent.model = new MockLlm(originalLlmResponse);
       const responses = await callLlmUnderTest();
       expect(responses).toEqual([beforeCallbackResponse]);
     });

  // 4. Plugin afterModelCallback overrides response.
  it('uses plugin after model callback to override response', async () => {
    mockPlugin.afterModelResponse = afterPluginResponse;
    pluginManager.registerPlugin(mockPlugin);
    const afterCallback: SingleAfterModelCallback = async () =>
        afterCallbackResponse;
    agent.afterModelCallback = [afterCallback];
    agent.model = new MockLlm(originalLlmResponse);
    const responses = await callLlmUnderTest();
    expect(responses).toEqual([afterPluginResponse]);
  });

  // 5. No plugin afterModelCallback, canonical callback overrides.
  it('uses canonical after model callback when plugin returns undefined',
     async () => {
       pluginManager.registerPlugin(mockPlugin);
       const afterCallback: SingleAfterModelCallback = async () =>
           afterCallbackResponse;
       agent.afterModelCallback = [afterCallback];
       agent.model = new MockLlm(originalLlmResponse);
       const responses = await callLlmUnderTest();
       expect(responses).toEqual([afterCallbackResponse]);
     });

  // 6. LLM error, plugin onModelErrorCallback handles it.
  it('uses plugin on model error callback to handle LLM error', async () => {
    mockPlugin.onModelErrorResponse = onModelErrorPluginResponse;
    pluginManager.registerPlugin(mockPlugin);
    agent.model = new MockLlm(null, modelError);
    const responses = await callLlmUnderTest();
    expect(responses).toEqual([onModelErrorPluginResponse]);
  });

  // 7. LLM error, no plugin callback, error message propagates.
  it('propagates LLM error message when no plugin callback is present',
     async () => {
       pluginManager.registerPlugin(mockPlugin);
       agent.model = new MockLlm(null, modelError);
       const responses = await callLlmUnderTest();
       expect(responses).toEqual(
           [{errorMessage: 'LLM error', errorCode: '500'}]);
     });
});
