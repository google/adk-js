/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AnchoredContextCompactor,
  BasePlugin,
  CompactedEvent,
  ContextCompactionTrigger,
  Gemini,
  InMemoryRunner,
  InvocationContext,
  isCompactedEvent,
  isScratchpadEvent,
  LlmAgent,
  LlmSummarizer,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

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

function createAnchoredCompactionAgent(): LlmAgent {
  const compactor = new AnchoredContextCompactor({
    tokenThreshold: 200, // Artificially low token limit.
    eventRetentionSize: 2, // Keep the last 2 events uncompacted out of those triggered.
    summarizer: new LlmSummarizer({
      llm: new Gemini({model: 'gemini-2.5-flash'}),
    }),
  });

  return new LlmAgent({
    name: 'anchored_compaction_agent',
    description:
      'An agent configured to test live anchored context compaction.',
    instruction:
      'You are a helpful conversational AI. Please provide short, single-sentence answers.',
    model: 'gemini-2.5-flash',
    contextCompactors: [compactor],
  });
}

describe('E2e Anchored Context Compaction', () => {
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
    'should hit token threshold and maintain a persistent scratchpad at index 0',
    async () => {
      const agent = createAnchoredCompactionAgent();
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

      const events = updatedSession!.events;

      // Find if there is a CompactedEvent
      const compactedEvents = events.filter(isCompactedEvent);
      expect(compactedEvents.length).toBeGreaterThan(0);

      // In AnchoredContextCompactor, the scratchpad should be at index 0
      const firstEvent = events[0];
      expect(isScratchpadEvent(firstEvent)).toBe(true);
      expect(firstEvent.author).toBe('system');
      expect((firstEvent as CompactedEvent).compactedContent).toBeTruthy();

      // Verify that there is at most one scratchpad event
      const scratchpads = events.filter(isScratchpadEvent);
      expect(scratchpads.length).toBe(1);

      // Verify that the plugin callbacks were called
      expect(plugin.beforeCalled).toBe(true);
      expect(plugin.afterCalled).toBe(true);
    },
    30000,
  );
});
