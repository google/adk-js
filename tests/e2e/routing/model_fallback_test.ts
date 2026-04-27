/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, Gemini, LlmRequest, RoutedLlm} from '@google/adk';
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

describe.skipIf(!hasAKey)('E2e Model Fallback with RoutedLlm', () => {
  it('should fallback to valid model if the primary model fails with a real error', async () => {
    // Configuration for RoutedLlm
    // First model is invalid and WILL fail on generation.
    const failingModel = new Gemini({model: 'gemini-unknown-model-fail'});
    // Second model is valid and should succeed.
    const fallbackModel = new Gemini({model: 'gemini-3-flash-preview'});

    const testModels = {
      'model-failing': failingModel,
      'model-fallback': fallbackModel,
    };

    let routerCalls = 0;
    const router = async (
      models: Readonly<Record<string, BaseLlm>>,
      req: LlmRequest,
      context?: {failedKeys: ReadonlySet<string>; lastError: unknown},
    ) => {
      routerCalls++;
      if (!context) {
        return 'model-failing'; // Try the failing model first
      }
      if (context.failedKeys.has('model-failing')) {
        return 'model-fallback'; // Fallback to working model
      }
      return undefined;
    };

    const routedLlm = new RoutedLlm({models: testModels, router});

    const request: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [{text: 'Hello, are you there? Reply with YES.'}],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    let finalResponse = '';

    for await (const response of generator) {
      if (response.content?.parts?.[0]?.text) {
        finalResponse += response.content.parts[0].text;
      }
    }

    expect(finalResponse).toBeTruthy();
    expect(routerCalls).toBe(2); // Initial call + fallback call
  }, 30000); // Timeout
});
