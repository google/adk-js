/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';

import {
  Blob,
  Content,
  createModelContent,
  GenerateContentResponse,
} from '@google/genai';

class TestLlmConnection implements BaseLlmConnection {
  async sendHistory(_history: Content[]): Promise<void> {
    return Promise.resolve();
  }

  async sendContent(_content: Content): Promise<void> {}

  async sendRealtime(_blob: Blob): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {}

  async close(): Promise<void> {}
}

class TestLlmModel extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }

  static override readonly supportedModels = ['test-llm-model'];

  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const generateContentResponse = new GenerateContentResponse();

    generateContentResponse.candidates = [
      {content: createModelContent('test-llm-model-response')},
    ];
    const candidate = generateContentResponse.candidates[0];

    yield {
      content: candidate.content,
      groundingMetadata: candidate.groundingMetadata,
      usageMetadata: generateContentResponse.usageMetadata,
      finishReason: candidate.finishReason,
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new TestLlmConnection();
  }
}

describe('LLMRegistry', () => {
  beforeAll(() => {
    LLMRegistry.register(TestLlmModel);
  });

  it('resolves model to LLM class', () => {
    expect(LLMRegistry.newLlm('test-llm-model')).toBeInstanceOf(TestLlmModel);
  });

  it('resolves the provided as a string model correctly in LlmAgent', () => {
    const agent = new LlmAgent({name: 'test_agent', model: 'test-llm-model'});

    expect(agent.canonicalModel).toBeInstanceOf(TestLlmModel);
  });

  it('resolves the provided as class model correctly in LlmAgent', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new TestLlmModel({model: 'test-llm-model'}),
    });

    expect(agent.canonicalModel).toBeInstanceOf(TestLlmModel);
  });
});

class AlternationLlmModel extends TestLlmModel {
  static override readonly supportedModels = ['model-a|model-b'];
}

describe('LLMRegistry.resolve with alternation patterns', () => {
  beforeAll(() => {
    LLMRegistry.register(AlternationLlmModel);
  });

  it('resolves every alternative of the pattern', () => {
    expect(LLMRegistry.resolve('model-a')).toBe(AlternationLlmModel);
    expect(LLMRegistry.resolve('model-b')).toBe(AlternationLlmModel);
  });

  it('rejects a name that only starts or ends with an alternative', () => {
    expect(() => LLMRegistry.resolve('model-a-extra')).toThrow(
      'Model model-a-extra not found.',
    );
    expect(() => LLMRegistry.resolve('prefix-model-b')).toThrow(
      'Model prefix-model-b not found.',
    );
  });
});
