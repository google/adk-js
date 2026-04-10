/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Gemini,
  InMemoryMemoryService,
  isCompactedEvent,
  LlmAgent,
  LlmSummarizer,
  Runner,
  TokenBasedContextCompactor,
  VertexAiSessionService,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

function createVertexAICompactionAgent(): LlmAgent {
  const compactor = new TokenBasedContextCompactor({
    tokenThreshold: 50, // Artificially low token limit.
    eventRetentionSize: 2, // Keep the last 2 events uncompacted out of those triggered.
    summarizer: new LlmSummarizer({
      llm: new Gemini({model: 'gemini-2.5-flash', vertexai: true}),
    }),
  });

  const agentModel = new Gemini({model: 'gemini-2.5-flash', vertexai: true});
  return new LlmAgent({
    name: 'compaction_agent',
    description: 'An agent configured to test live context compaction.',
    instruction:
      'You are a helpful conversational AI. Please provide short, single-sentence answers.',
    model: agentModel,
    contextCompactors: [compactor],
  });
}

describe('E2e Context Compaction (Vertex AI)', () => {
  const envPath = path.resolve(__dirname, '.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasRequiredEnv =
    !!process.env.GOOGLE_CLOUD_PROJECT && !!process.env.REASONING_ENGINE_ID;

  it.skipIf(!hasRequiredEnv)(
    'should hit token threshold and compact history using Vertex AI Sessions',
    async () => {
      const agent = createVertexAICompactionAgent();

      const projectId = process.env.GOOGLE_CLOUD_PROJECT!;
      const location = process.env.LOCATION || 'us-west1';
      const agentEngineId = process.env.REASONING_ENGINE_ID!;

      const sessionService = new VertexAiSessionService({
        projectId,
        location,
        agentEngineId,
      });
      const memoryService = new InMemoryMemoryService();

      const runner = new Runner({
        appName: `projects/${projectId}/locations/${location}/reasoningEngines/${agentEngineId}`,
        agent,
        sessionService,
        memoryService,
      });

      const session = await runner.sessionService.createSession({
        appName: `projects/${projectId}/locations/${location}/reasoningEngines/${agentEngineId}`,
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
          // Consume the events.
        }
      }

      const updatedSession = await runner.sessionService.getSession({
        appName: 'e2e_test',
        userId: 'test_user',
        sessionId: session.id,
      });

      const compactedEvents = updatedSession!.events.filter(isCompactedEvent);
      expect(compactedEvents.length).toBeGreaterThan(0);

      const latestCompacted = compactedEvents[compactedEvents.length - 1];
      expect(latestCompacted.compactedContent).toBeTruthy();
      expect(latestCompacted.compactedContent.length).toBeGreaterThan(0);
    },
    30000,
  );
});
