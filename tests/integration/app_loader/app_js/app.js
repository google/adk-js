/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const {App, BaseLlm, LlmAgent, LLMRegistry} = require('@google/adk');
const {createModelContent} = require('@google/genai');
const fs = require('node:fs/promises');
const path = require('node:path');
const {MockLlmConnection} = require('../../mock_llm_connection');

class MockLlmJsApp extends BaseLlm {
  constructor({model}) {
    super({model});
  }
  static supportedModels = ['test-llm-app-js'];
  async *generateContentAsync() {
    const paramsPath = path.join(__dirname, 'model_response.json');
    const params = JSON.parse(await fs.readFile(paramsPath, 'utf8'));
    const message = params.message;

    yield {content: createModelContent(message)};
  }
  async connect() {
    return new MockLlmConnection();
  }
}

LLMRegistry.register(MockLlmJsApp);

const rootAgent = new LlmAgent({
  name: 'app_js_agent',
  model: 'test-llm-app-js',
  description: 'Agent for app.js integration test',
});

exports.app = new App({
  name: 'js_app_integration',
  rootAgent,
});
