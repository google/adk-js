/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseLlm,
  BaseLlmConnection,
  LlmAgent,
  LLMRegistry,
  LlmResponse,
} from '@google/adk';
import {createModelContent} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {MockLlmConnection} from '../../mock_llm_connection';

class MockLlmDefaultApp extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }
  static override readonly supportedModels = ['test-llm-app-default'];
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const paramsPath = path.join(__dirname, 'model_response.json');
    const params = JSON.parse(await fs.readFile(paramsPath, 'utf8'));
    const message = params.message;

    yield {content: createModelContent(message)};
  }
  async connect(): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

LLMRegistry.register(MockLlmDefaultApp);

const rootAgent = new LlmAgent({
  name: 'app_default_agent',
  model: 'test-llm-app-default',
  description: 'Agent for default export app integration test',
});

export default new App({
  name: 'default_app_integration',
  rootAgent,
});
