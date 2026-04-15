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
  LlmResponse,
} from '@google/adk';
import {createModelContent} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MockLlmConnection} from '../../mock_llm_connection.js';

class MockLll extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }
  static override readonly supportedModels = ['test-llm-model'];
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const paramsPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
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
  name: 'import_meta_agent',
  model: 'test-llm-model',
  description: 'Agent that tests import.meta.url',
});
