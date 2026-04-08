/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  ContextCompactionTrigger,
  InMemoryRunner,
  InvocationContext,
  isCompactedEvent,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {createCompactionAgent} from './agent.js';

class TestCompactionPlugin extends BasePlugin {
  beforeCalled = false;
  afterCalled = false;

  constructor() {
    super('TestCompactionPlugin');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async beforeContextCompaction(params: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }) {
    this.beforeCalled = true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async afterContextCompaction(params: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }) {
    this.afterCalled = true;
  }
}

describe('E2e Context Compaction', () => {
  const envPath = path.resolve(__dirname, '.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  it.skipIf(!hasAKey)(
    'should hit token threshold and compact history using Gemini API',
    async () => {
      // Instantiate agent inside the test so it relies on the loaded env variations
      const agent = createCompactionAgent();
      const plugin = new TestCompactionPlugin();
      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_test',
        plugins: [plugin],
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_test',
        userId: 'test_user',
      });

      const turns = [
        'Tell me a long story about a brave knight named Sir Galahad exploring a dragon-infested cave.',
        'What happens after he finds the treasure?',
        'Can you summarize his entire adventure in 3 sentences?',
      ];

      for (const prompt of turns) {
        const responseGen = runner.runAsync({
          userId: 'test_user',
          sessionId: session.id,
          newMessage: createUserContent(prompt),
        });

        for await (const _ of responseGen) {
          // Drain the generator to let the agent run and append events
        }
      }

      // Now retrieve the session and check its events
      const updatedSession = await runner.sessionService.getSession({
        appName: 'e2e_test',
        userId: 'test_user',
        sessionId: session.id,
      });

      // Find if there is a CompactedEvent
      const compactedEvents = updatedSession!.events.filter(isCompactedEvent);
      expect(compactedEvents.length).toBeGreaterThan(0);

      const latestCompacted = compactedEvents[compactedEvents.length - 1];
      expect(latestCompacted.compactedContent).toBeTruthy();
      expect(latestCompacted.compactedContent.length).toBeGreaterThan(0);

      // Verify that the plugin callbacks were called
      expect(plugin.beforeCalled).toBe(true);
      expect(plugin.afterCalled).toBe(true);
    },
    30000,
  ); // 30 sec timeout for e2e LLM tests
});
