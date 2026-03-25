/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmRequest,
  LlmResponse,
  RoutedLlm,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockLlm extends BaseLlm {
  constructor(modelName: string) {
    super({model: modelName});
  }

  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    yield {
      content: {
        role: 'model',
        parts: [{text: `Response from ${this.model}`}],
      },
    } as LlmResponse;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return {} as BaseLlmConnection;
  }
}

describe('RoutedLlm', () => {
  const modelA = new MockLlm('model-a');
  const modelB = new MockLlm('model-b');
  const models = [modelA, modelB];

  it('should route generateContentAsync to the selected model A', async () => {
    let selectorCalledWithModels: ReadonlyMap<string, BaseLlm> | null = null;
    let selectorCalledWithRequest: LlmRequest | null = null;
    const selector = async (
      models: ReadonlyMap<string, BaseLlm>,
      req: LlmRequest,
    ) => {
      selectorCalledWithModels = models;
      selectorCalledWithRequest = req;
      return 'model-a';
    };

    const routedLlm = new RoutedLlm({models, selector});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    const result = await generator.next();

    expect(result.value?.content?.parts?.[0]?.text).toBe(
      'Response from model-a',
    );
    expect(selectorCalledWithRequest).toBe(request);
    expect(selectorCalledWithModels).toBeDefined();
  });

  it('should route generateContentAsync to the selected model B', async () => {
    const selector = async (
      _models: ReadonlyMap<string, BaseLlm>,
      _req: LlmRequest,
    ) => 'model-b';

    const routedLlm = new RoutedLlm({models, selector});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    const result = await generator.next();

    expect(result.value?.content?.parts?.[0]?.text).toBe(
      'Response from model-b',
    );
  });

  it('should throw error if selected model is not found', async () => {
    const selector = async (
      _models: ReadonlyMap<string, BaseLlm>,
      _req: LlmRequest,
    ) => 'unknown-model';

    const routedLlm = new RoutedLlm({models, selector});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);

    await expect(generator.next()).rejects.toThrow(
      'Model not found for key: unknown-model',
    );
  });

  it('should route connect to the selected model', async () => {
    let selectorCalled = false;
    const selector = async (
      _models: ReadonlyMap<string, BaseLlm>,
      _req: LlmRequest,
    ) => {
      selectorCalled = true;
      return 'model-b';
    };

    const routedLlm = new RoutedLlm({models, selector});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await routedLlm.connect(request);

    expect(selectorCalled).toBe(true);
  });
});
