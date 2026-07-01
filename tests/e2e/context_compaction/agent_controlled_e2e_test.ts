/**
 * @license
 * Copyright 2026 Google LLC
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
import {createAgentControlledCompactionAgent} from './agent.js';

class TestCompactionPlugin extends BasePlugin {
  beforeCalled = false;
  afterCalled = false;
  detectedTrigger?: ContextCompactionTrigger;

  constructor() {
    super('TestCompactionPlugin');
  }

  override async beforeContextCompaction(params: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }) {
    this.beforeCalled = true;
    this.detectedTrigger = params.trigger;
  }

  override async afterContextCompaction(_params: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }) {
    this.afterCalled = true;
  }
}

describe('E2e Context Compaction Agent-Controlled', () => {
  for (const p of [
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '../../../.env'),
  ]) {
    if (fs.existsSync(p)) {
      dotenv.config({path: p});
      break;
    }
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  it.skipIf(!hasAKey)(
    'should compact history when agent calls consolidate_context using Gemini API',
    async () => {
      const agent = createAgentControlledCompactionAgent();
      const plugin = new TestCompactionPlugin();
      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_agent_controlled_test',
        plugins: [plugin],
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_agent_controlled_test',
        userId: 'test_user',
      });

      const turns = [
        'Hi, I want to plan a trip to Tokyo. Let us start by listing 3 top attractions.',
        'Great, now please consolidate what we have planned so far and summarize it.',
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
        appName: 'e2e_agent_controlled_test',
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
      expect(plugin.detectedTrigger).toEqual(
        ContextCompactionTrigger.AgentControlled,
      );
    },
    60000, // 60 sec timeout for e2e LLM tests (might take longer if multiple turns and tools)
  );
});
