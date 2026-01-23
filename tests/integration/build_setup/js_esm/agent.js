/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {BaseLlm, LlmAgent, LLMRegistry, LogLevel, setLogLevel} from '@google/adk';
import {createModelContent, GenerateContentResponse} from '@google/genai';

setLogLevel(LogLevel.DEBUG);

class MockLlmConnection {
  async sendHistory() {
    return Promise.resolve();
  }

  async sendContent() {
    return Promise.resolve();
  }

  async sendRealtime(blob) {}

  async * receive() {}

  async close() {}
}

class MockLll extends BaseLlm {
  static supportedModels = ['test-llm-model'];

  async generateContentAsync(prompt) {
    return `Mock response to: ${prompt}`;
  }

  async * generateContentAsync(llmRequest) {
    const generateContentResponse = new GenerateContentResponse();

    generateContentResponse.candidates =
        [{content: createModelContent('test-llm-model-response')}];
    const candidate = generateContentResponse.candidates[0];

    yield {
      content: candidate.content,
      groundingMetadata: candidate.groundingMetadata,
      usageMetadata: generateContentResponse.usageMetadata,
      finishReason: candidate.finishReason,
    };
  }

  async connect() {
    return new MockLlmConnection();
  }
}

LLMRegistry.register(MockLll);

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'test-llm-model',
  description: 'Root agent',
});
