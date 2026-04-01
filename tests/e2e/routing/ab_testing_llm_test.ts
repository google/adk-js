/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Gemini, LlmRequest, RoutedLlm} from '@google/adk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

const envPath = path.resolve(__dirname, '.env');
const envExists = fs.existsSync(envPath);

if (envExists) {
  dotenv.config({path: envPath});
}

const hasAKey =
  !!process.env.GEMINI_API_KEY ||
  !!process.env.GOOGLE_GENAI_API_KEY ||
  !!process.env.GOOGLE_CLOUD_PROJECT;

describe.skipIf(!hasAKey)('E2e A/B Testing with RoutedLlm', () => {
  // External configuration mock
  const config = {
    selectedModel: 'model-a', // Default
  };

  const router = async () => {
    return config.selectedModel;
  };

  it('should route to model-a when config is set to model-a', async () => {
    config.selectedModel = 'model-a';

    const modelA = new Gemini({model: 'gemini-3-flash-preview'});
    const modelB = new Gemini({model: 'gemini-3.1-pro-preview'});

    const models = {
      'model-a': modelA,
      'model-b': modelB,
    };

    const routedLlm = new RoutedLlm({models, router});

    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    let responseText = '';
    for await (const response of generator) {
      if (response.content?.parts?.[0]?.text) {
        responseText += response.content.parts[0].text;
      }
    }
    expect(responseText).toBeTruthy();
  }, 30000);

  it('should route to model-b when config is set to model-b', async () => {
    config.selectedModel = 'model-b';

    const modelA = new Gemini({model: 'gemini-3-flash-preview'});
    const modelB = new Gemini({model: 'gemini-3.1-pro-preview'});

    const models = {
      'model-a': modelA,
      'model-b': modelB,
    };

    const routedLlm = new RoutedLlm({models, router});

    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    let responseText = '';
    for await (const response of generator) {
      if (response.content?.parts?.[0]?.text) {
        responseText += response.content.parts[0].text;
      }
    }
    expect(responseText).toBeTruthy();
  }, 30000);
});
