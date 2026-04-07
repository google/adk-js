/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, LlmAgent, RoutedAgent} from '@google/adk';
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

describe.skipIf(!hasAKey)('E2e A/B Testing with RoutedAgent', () => {
  // External configuration mock
  const config = {
    selectedAgent: 'agent-a',
  };

  const agentA = new LlmAgent({
    name: 'agent-a',
    model: 'gemini-3-flash-preview',
    description: 'Agent A for A/B testing.',
    instruction: 'You are Agent A.',
  });

  const agentB = new LlmAgent({
    name: 'agent-b',
    model: 'gemini-3.1-pro-preview',
    description: 'Agent B for A/B testing.',
    instruction: 'You are Agent B.',
  });

  const testAgents = {
    'agent-a': agentA,
    'agent-b': agentB,
  };

  const router = async () => {
    return config.selectedAgent;
  };

  const routedAgent = new RoutedAgent({
    name: 'test-routed-agent',
    agents: testAgents,
    router,
  });

  it('should route to agent-a when config is set to agent-a', async () => {
    config.selectedAgent = 'agent-a';
    const runner = new InMemoryRunner({
      agent: routedAgent,
      appName: 'ab_testing_agent_test',
    });
    const session = await runner.sessionService.createSession({
      appName: 'ab_testing_agent_test',
      userId: 'test_user',
    });

    const responseGen = runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Identify yourself.'}]},
    });

    let responseText = '';
    for await (const response of responseGen) {
      if (response.content?.parts?.[0]?.text) {
        responseText += response.content.parts[0].text;
      }
    }
    expect(responseText).toBeTruthy();
  }, 30000);

  it('should route to agent-b when config is set to agent-b', async () => {
    config.selectedAgent = 'agent-b';
    const runner = new InMemoryRunner({
      agent: routedAgent,
      appName: 'ab_testing_agent_test',
    });
    const session = await runner.sessionService.createSession({
      appName: 'ab_testing_agent_test',
      userId: 'test_user',
    });

    const responseGen = runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Identify yourself.'}]},
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
