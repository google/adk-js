/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, LlmAgent, LOAD_ARTIFACTS} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

describe('E2E LoadArtifactsTool', () => {
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
    'should use Gemini API to invoke load_artifacts and answer from it',
    async () => {
      const agent = new LlmAgent({
        name: 'e2e_artifact_agent',
        description: 'An agent that reads artifacts.',
        instruction:
          'You have tools to load artifacts. Use them to read artifacts if the user asks about them, and give a short answer based solely on the artifact content.',
        model: 'gemini-2.5-flash',
        tools: [LOAD_ARTIFACTS],
      });

      const runner = new InMemoryRunner({agent, appName: 'e2e_tool_test'});
      const session = await runner.sessionService.createSession({
        appName: 'e2e_tool_test',
        userId: 'test_user',
      });

      // Provide an artifact
      const csvBytes = Buffer.from(
        'name,age\nAlice,30\nBob,25\n',
        'utf8',
      ).toString('base64');
      await runner.artifactService!.saveArtifact({
        appName: 'e2e_tool_test',
        userId: 'test_user',
        sessionId: session.id,
        filename: 'people.csv',
        artifact: {
          inlineData: {
            data: csvBytes,
            mimeType: 'application/csv',
          },
        },
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent(
          'What is the age of Alice in people.csv?',
        ),
      })) {
        if (
          event.author === 'e2e_artifact_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      // Check the output
      expect(finalResponse.toLowerCase()).toContain('30');
    },
    30000,
  );
});
