/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmAgent,
  LLMRegistry,
  LlmResponse,
} from '@google/adk';
import {createModelContent} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
  static override readonly supportedModels = ['test-llm-model'];
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const paramsPath = path.join(
      path.dirname(__filename),
      'model_response.json',
    );
    const params = JSON.parse(await fs.readFile(paramsPath, 'utf8'));
    const message = params.message;

    yield {content: createModelContent(message)};
  }
  async connect(): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

LLMRegistry.register(MockLll);

export const rootAgent = new LlmAgent({
  name: 'filename_agent',
  model: 'test-llm-model',
  description: 'Agent that tests __filename',
});
