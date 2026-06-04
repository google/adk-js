/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentTool, InMemoryRunner, LlmAgent, State} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

describe('E2E AgentTool State Filtering', () => {
  const envPath = path.resolve(__dirname, '../../.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  it('should always pass (dummy test for vitest)', () => {
    expect(true).toBe(true);
  });

  it.skipIf(!hasAKey)(
    'should not propagate temp state keys from parent to sub-agent session',
    async () => {
      const subAgent = new LlmAgent({
        name: 'sub_agent',
        description: 'A sub-agent helper.',
        instruction: 'You are a helpful assistant. Just say hello.',
        model: 'gemini-2.5-flash',
      });

      const parentAgent = new LlmAgent({
        name: 'parent_agent',
        description: 'A parent agent.',
        instruction: 'Use your sub_agent tool to greet the user.',
        model: 'gemini-2.5-flash',
        tools: [new AgentTool({agent: subAgent})],
      });

      const runner = new InMemoryRunner({
        agent: parentAgent,
        appName: 'e2e_agent_tool_test',
      });

      const session = await runner.sessionService.createSession({
        appName: 'e2e_agent_tool_test',
        userId: 'test_user',
        state: {
          normalKey: 'parent_value',
          [`${State.TEMP_PREFIX}tempKey`]: 'should_be_filtered',
        },
      });

      // Run the parent agent which should invoke the sub-agent
      for await (const _event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent('Call your sub_agent to say hello.'),
      })) {
        // Let it run
      }

      // Retrieve the sub-agent's session
      const subAgentSession = await runner.sessionService.getSession({
        appName: 'sub_agent',
        userId: 'test_user',
        sessionId: session.id,
      });

      expect(subAgentSession).toBeDefined();
      expect(subAgentSession?.state).toHaveProperty(
        'normalKey',
        'parent_value',
      );
      expect(subAgentSession?.state).not.toHaveProperty(
        `${State.TEMP_PREFIX}tempKey`,
      );
    },
    30000,
  );
});
