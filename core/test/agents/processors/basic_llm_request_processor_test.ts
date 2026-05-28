/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  createSession,
  InvocationContext,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  PluginManager,
  RunConfig,
} from '@google/adk';
import {Content, Blob as GenaiBlob, Modality} from '@google/genai';
import {beforeAll, describe, expect, it} from 'vitest';
import {BASIC_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/basic_llm_request_processor.js';

class TestLlmConnection implements BaseLlmConnection {
  async sendHistory(_history: Content[]): Promise<void> {}
  async sendContent(_content: Content): Promise<void> {}
  async sendRealtime(_blob: GenaiBlob): Promise<void> {}
  async *receive(): AsyncGenerator<LlmResponse, void, void> {}
  async close(): Promise<void> {}
}

class TestLlmModel extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }
  static override readonly supportedModels = ['test-basic-processor-model'];
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {}
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new TestLlmConnection();
  }
}

class MockRootAgent extends BaseAgent {
  constructor(name: string, subAgents: BaseAgent[] = []) {
    super({name, subAgents});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createMockInvocationContext(
  agent: BaseAgent,
  runConfig?: RunConfig,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    runConfig,
  });
}

function makeLlmRequest(): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

async function runProcessor(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
) {
  for await (const _ of BASIC_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // intentionally empty
  }
}

describe('BasicLlmRequestProcessor', () => {
  beforeAll(() => {
    LLMRegistry.register(TestLlmModel);
  });

  it('should do nothing if agent is not an LlmAgent', async () => {
    const agent = new MockRootAgent('test_agent');
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.model).toBeUndefined();
    expect(llmRequest.config).toBeUndefined();
  });

  it('should set model string from canonicalModel', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.model).toBe('test-basic-processor-model');
  });

  it('should set config from generateContentConfig', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      generateContentConfig: {temperature: 0.5, maxOutputTokens: 100},
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config).toMatchObject({
      temperature: 0.5,
      maxOutputTokens: 100,
    });
  });

  it('should set empty config when generateContentConfig is not set', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config).toEqual({});
  });

  it('should set outputSchema in config when agent has outputSchema', async () => {
    const outputSchema = {
      type: 'object' as const,
      properties: {
        answer: {type: 'string' as const},
      },
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      outputSchema,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.responseSchema).toBeDefined();
    expect(llmRequest.config?.responseMimeType).toBe('application/json');
  });

  it('should populate liveConnectConfig from runConfig', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const runConfig: RunConfig = {
      responseModalities: ['AUDIO' as unknown as Modality],
      speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Puck'}}},
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      enableAffectiveDialog: true,
    };
    const invocationContext = createMockInvocationContext(agent, runConfig);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.liveConnectConfig.responseModalities).toEqual(['AUDIO']);
    expect(llmRequest.liveConnectConfig.speechConfig).toEqual(
      runConfig.speechConfig,
    );
    expect(llmRequest.liveConnectConfig.outputAudioTranscription).toEqual({});
    expect(llmRequest.liveConnectConfig.inputAudioTranscription).toEqual({});
    expect(llmRequest.liveConnectConfig.enableAffectiveDialog).toBe(true);
  });

  it('should not populate liveConnectConfig when runConfig is not set', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.liveConnectConfig.responseModalities).toBeUndefined();
    expect(llmRequest.liveConnectConfig.speechConfig).toBeUndefined();
  });

  it('should yield no events', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    const events = [];
    for await (const event of BASIC_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });
});
