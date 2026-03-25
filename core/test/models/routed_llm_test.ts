/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {RoutedLlm} from '../../src/models/routed_llm.js';

class MockLlm extends BaseLlm {
  constructor(modelName: string) {
    super({model: modelName});
  }

  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    yield {
      contents: [
        {
          role: 'model',
          parts: [{text: `Response from ${this.model}`}],
        },
      ],
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
    let selectorCalledWith: LlmRequest | null = null;
    const selector = async (req: LlmRequest) => {
      selectorCalledWith = req;
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

    expect(result.value?.contents?.[0]?.parts?.[0]?.text).toBe(
      'Response from model-a',
    );
    expect(selectorCalledWith).toBe(request);
  });

  it('should route generateContentAsync to the selected model B', async () => {
    const selector = async (_req: LlmRequest) => 'model-b';

    const routedLlm = new RoutedLlm({models, selector});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    const result = await generator.next();

    expect(result.value?.contents?.[0]?.parts?.[0]?.text).toBe(
      'Response from model-b',
    );
  });

  it('should throw error if selected model is not found', async () => {
    const selector = async (_req: LlmRequest) => 'unknown-model';

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
    const selector = async (_req: LlmRequest) => {
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
