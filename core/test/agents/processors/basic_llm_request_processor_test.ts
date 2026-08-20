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
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  PluginManager,
  RunConfig,
} from '@google/adk';
import {
  Content,
  Blob as GenaiBlob,
  Modality,
  Schema,
  Type,
} from '@google/genai';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {BASIC_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/basic_llm_request_processor.js';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

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
    const outputSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        answer: {type: Type.STRING},
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

  it('should not set outputSchema in config when agent has outputSchema and tools', async () => {
    const outputSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        answer: {type: Type.STRING},
      },
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      outputSchema,
      tools: [
        new FunctionTool({
          name: 'some_tool',
          description: 'A test tool',
          execute: () => 'result',
        }),
      ],
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.responseSchema).toBeUndefined();
    expect(llmRequest.config?.responseMimeType).toBeUndefined();
  });

  describe('outputSchema with tools on a model that supports both', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function runWithOutputSchemaAndTools(
      model: string,
    ): Promise<LlmRequest> {
      const agent = new LlmAgent({
        name: 'test_agent',
        // A model instance is used so that `canonicalModel` resolves without
        // credentials.
        model: new TestLlmModel({model}),
        outputSchema: OUTPUT_SCHEMA,
        tools: [
          new FunctionTool({
            name: 'some_tool',
            description: 'A test tool',
            execute: () => 'result',
          }),
        ],
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      return llmRequest;
    }

    it('should set outputSchema on Vertex AI with a Gemini 2.0+ model', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, 'true');

      const llmRequest = await runWithOutputSchemaAndTools('gemini-2.5-flash');

      expect(llmRequest.config?.responseSchema).toBeDefined();
      expect(llmRequest.config?.responseMimeType).toBe('application/json');
    });

    it('should not set outputSchema on Vertex AI with a pre-2.0 model', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, 'true');

      const llmRequest = await runWithOutputSchemaAndTools('gemini-1.5-pro');

      expect(llmRequest.config?.responseSchema).toBeUndefined();
      expect(llmRequest.config?.responseMimeType).toBeUndefined();
    });

    it('should not set outputSchema outside the Vertex AI variant', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, undefined);

      const llmRequest = await runWithOutputSchemaAndTools('gemini-2.5-flash');

      expect(llmRequest.config?.responseSchema).toBeUndefined();
      expect(llmRequest.config?.responseMimeType).toBeUndefined();
    });
  });

  it('should populate liveConnectConfig from runConfig', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const runConfig: RunConfig = {
      responseModalities: [Modality.AUDIO],
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
