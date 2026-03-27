/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type {BaseLlmConnection, LlmResponse} from '@google/adk';
import {
  BaseLlm,
  LlmAgent,
  LLMRegistry,
  LogLevel,
  setLogLevel,
} from '@google/adk';
import {createModelContent, GenerateContentResponse} from '@google/genai';
import nativeAddon from 'onnxruntime-node';

setLogLevel(LogLevel.DEBUG);

class MockLlmConnection implements BaseLlmConnection {
  async sendHistory(): Promise<void> {
    return Promise.resolve();
  }

  async sendContent(): Promise<void> {}

  async sendRealtime(): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {}

  async close(): Promise<void> {}
}

class MockLll extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }

  static readonly supportedModels = ['test-llm-model'];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const generateContentResponse = new GenerateContentResponse();

    generateContentResponse.candidates = [
      {
        content: createModelContent(
          `test-llm-model-response:${nativeAddon.status()}`,
        ),
      },
    ];
    const candidate = generateContentResponse.candidates[0]!;

    yield {
      content: candidate.content,
      groundingMetadata: candidate.groundingMetadata,
      usageMetadata: generateContentResponse.usageMetadata,
      finishReason: candidate.finishReason,
    };
  }

  async connect(): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

LLMRegistry.register(MockLll);

const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'test-llm-model',
  description: nativeAddon.status(),
});

module.exports = {rootAgent};
