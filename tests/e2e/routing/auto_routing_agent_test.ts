/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Gemini,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  RoutedAgent,
} from '@google/adk';
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

describe.skipIf(!hasAKey)('E2e Auto Routing with RoutedAgent', () => {
  it('should route to simple agent for simple request', async () => {
    const simpleAgent = new LlmAgent({
      name: 'simple_agent',
      model: 'gemini-3-flash-preview',
      description: 'Simple agent for basic tasks.',
      instruction: 'You are a simple assistant.',
    });

    const complexAgent = new LlmAgent({
      name: 'complex_agent',
      model: 'gemini-3.1-pro-preview',
      description: 'Complex agent for advanced tasks.',
      instruction: 'You are a complex assistant.',
    });

    const testAgents = {
      'simple': simpleAgent,
      'complex': complexAgent,
    };

    const classifierModel = new Gemini({
      model: 'gemini-3.1-flash-lite-preview',
    });

    const router = async (
      agents: Readonly<Record<string, BaseAgent>>,
      context: InvocationContext,
    ) => {
      const text = context.userContent?.parts?.[0]?.text || '';
      if (!text) return 'simple'; // Default

      const prompt = `Classify the following request as either 'simple' or 'complex'. Reply with ONLY 'simple' or 'complex'.
Request: "${text}"`;

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

    const routedAgent = new RoutedAgent({
      name: 'test-routed-agent',
      agents: testAgents,
      router,
    });

    const runner = new InMemoryRunner({
      agent: routedAgent,
      appName: 'auto_routing_agent_test',
    });
    const session = await runner.sessionService.createSession({
      appName: 'auto_routing_agent_test',
      userId: 'test_user',
    });

    const responseGen = runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'What is 1+1?'}]},
    });

    let responseText = '';
    for await (const response of responseGen) {
      if (response.content?.parts?.[0]?.text) {
        responseText += response.content.parts[0].text;
      }
    }
    expect(responseText).toBeTruthy();
  }, 30000);

  it('should route to complex agent for complex request', async () => {
    const simpleAgent = new LlmAgent({
      name: 'simple_agent',
      model: 'gemini-3-flash-preview',
      description: 'Simple agent for basic tasks.',
      instruction: 'You are a simple assistant.',
    });

    const complexAgent = new LlmAgent({
      name: 'complex_agent',
      model: 'gemini-3.1-pro-preview',
      description: 'Complex agent for advanced tasks.',
      instruction: 'You are a complex assistant.',
    });

    const testAgents = {
      'simple': simpleAgent,
      'complex': complexAgent,
    };

    const classifierModel = new Gemini({
      model: 'gemini-3.1-flash-lite-preview',
    });

    const router = async (
      agents: Readonly<Record<string, BaseAgent>>,
      context: InvocationContext,
    ) => {
      const text = context.userContent?.parts?.[0]?.text || '';
      if (!text) return 'simple';

      const prompt = `Classify the following request as either 'simple' or 'complex'. Reply with ONLY 'simple' or 'complex'.
Request: "${text}"`;

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

    const routedAgent = new RoutedAgent({
      name: 'test-routed-agent',
      agents: testAgents,
      router,
    });

    const runner = new InMemoryRunner({
      agent: routedAgent,
      appName: 'auto_routing_agent_test',
    });
    const session = await runner.sessionService.createSession({
      appName: 'auto_routing_agent_test',
      userId: 'test_user',
    });

    const responseGen = runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            text: 'Explain quantum field theory in the context of general relativity.',
          },
        ],
      },
    });

    let responseText = '';
    for await (const response of responseGen) {
      if (response.content?.parts?.[0]?.text) {
        responseText += response.content.parts[0].text;
      }
    }
    expect(responseText).toBeTruthy();
  }, 30000);
});
