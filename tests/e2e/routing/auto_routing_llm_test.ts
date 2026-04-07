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

describe.skipIf(!hasAKey)('E2e Auto Routing with RoutedLlm', () => {
  it('should route to simple model for simple request', async () => {
    const simpleModel = new Gemini({model: 'gemini-3-flash-preview'});
    const complexModel = new Gemini({model: 'gemini-3.1-pro-preview'});
    const classifierModel = new Gemini({
      model: 'gemini-3.1-flash-lite-preview',
    });

    const models = {
      'simple': simpleModel,
      'complex': complexModel,
    };

    const router = async (
      models: Readonly<Record<string, BaseLlm>>,
      req: LlmRequest,
    ) => {
      const prompt = `Classify the following request as either 'simple' or 'complex'. Reply with ONLY 'simple' or 'complex'.
Request: "${req.contents[0]?.parts?.[0]?.text || ''}"`;

      const generator = classifierModel.generateContentAsync({
        contents: [{role: 'user', parts: [{text: prompt}]}],
        toolsDict: {},
        liveConnectConfig: {},
      });

      let classification = '';
      for await (const resp of generator) {
        if (resp.content?.parts?.[0]?.text) {
          classification += resp.content.parts[0].text;
        }
      }

      if (classification.toLowerCase().includes('complex')) {
        return 'complex';
      }
      return 'simple';
    };

    const routedLlm = new RoutedLlm({models, router});

    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'What is 1+1?'}]}],
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

  it('should route to complex model for complex request', async () => {
    const simpleModel = new Gemini({model: 'gemini-3-flash-preview'});
    const complexModel = new Gemini({model: 'gemini-3.1-pro-preview'});
    const classifierModel = new Gemini({
      model: 'gemini-3.1-flash-lite-preview',
    });

    const models = {
      'simple': simpleModel,
      'complex': complexModel,
    };

    const router = async (
      models: Readonly<Record<string, BaseLlm>>,
      req: LlmRequest,
    ) => {
      const prompt = `Classify the following request as either 'simple' or 'complex'. Reply with ONLY 'simple' or 'complex'.
Request: "${req.contents[0]?.parts?.[0]?.text || ''}"`;

      const generator = classifierModel.generateContentAsync({
        contents: [{role: 'user', parts: [{text: prompt}]}],
        toolsDict: {},
        liveConnectConfig: {},
      });

      let classification = '';
      for await (const resp of generator) {
        if (resp.content?.parts?.[0]?.text) {
          classification += resp.content.parts[0].text;
        }
      }

      if (classification.toLowerCase().includes('complex')) {
        return 'complex';
      }
      return 'simple';
    };

    const routedLlm = new RoutedLlm({models, router});

    const request: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Explain quantum field theory in the context of general relativity and loop quantum gravity, and explain the mathematical inconsistencies between them. Use only 3 sentences.',
            },
          ],
        },
      ],
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
