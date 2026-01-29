/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
const {
  BaseLlm,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  BaseLlmConnection,
  LlmAgent,
  LLMRegistry,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  LlmResponse,
  setLogLevel,
  LogLevel,
} = require('@google/adk'); // eslint-disable-line @typescript-eslint/no-require-imports
const {createModelContent, GenerateContentResponse} = require('@google/genai'); // eslint-disable-line @typescript-eslint/no-require-imports

type BaseLlmConnectionType = typeof BaseLlmConnection;
type LlmResponseType = typeof LlmResponse;

setLogLevel(LogLevel.DEBUG);

class MockLlmConnection implements BaseLlmConnectionType {
  async sendHistory(): Promise<void> {
    return Promise.resolve();
  }

  async sendContent(): Promise<void> {}

  async sendRealtime(): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponseType, void, void> {}

  async close(): Promise<void> {}
}

class MockLll extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }

  static readonly supportedModels = ['test-llm-model'];

  async *generateContentAsync(): AsyncGenerator<LlmResponseType, void> {
    const generateContentResponse = new GenerateContentResponse();

    generateContentResponse.candidates = [
      {content: createModelContent('test-llm-model-response')},
    ];
    const candidate = generateContentResponse.candidates[0]!;

    yield {
      content: candidate.content,
      groundingMetadata: candidate.groundingMetadata,
      usageMetadata: generateContentResponse.usageMetadata,
      finishReason: candidate.finishReason,
    };
  }

  async connect(): Promise<BaseLlmConnectionType> {
    return new MockLlmConnection();
  }
}

LLMRegistry.register(MockLll);

const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'test-llm-model',
  description: 'Root agent',
});

module.exports = {rootAgent};
