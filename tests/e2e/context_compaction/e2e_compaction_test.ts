/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, Runner, VertexAiSessionService, InMemoryMemoryService, isCompactedEvent} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {createCompactionAgent} from './agent.js';

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

  const hasRequiredEnv =
    !!process.env.GOOGLE_CLOUD_PROJECT &&
    !!process.env.REASONING_ENGINE_ID;

  it.skipIf(!hasAKey)(
    'should hit token threshold and compact history using Gemini API (InMemory)',
    async () => {
      const agent = createCompactionAgent();
      const runner = new InMemoryRunner({agent, appName: 'e2e_test'});

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

  it.skipIf(!hasRequiredEnv)(
    'should hit token threshold and compact history using Vertex AI Sessions',
    async () => {
      const agent = createCompactionAgent();

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
