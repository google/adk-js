/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, InMemoryRunner, LlmAgent, LOAD_MEMORY} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

describe('E2E LoadMemoryTool', () => {
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
    'should use Gemini API to invoke load_memory and answer from it',
    async () => {
      const agent = new LlmAgent({
        name: 'e2e_memory_agent',
        description: 'An agent that answers based on memory.',
        instruction:
          'You have tools to load memory. Use them if the user asks about their details and give a short answer based solely on the memory contents.',
        model: 'gemini-2.5-flash',
        tools: [LOAD_MEMORY],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_memory_test',
      });

      const session1 = await runner.sessionService.createSession({
        appName: 'e2e_memory_test',
        userId: 'test_user',
      });

      // Save a piece of memory by talking to a simple prompt, then saving the session
      await runner.sessionService.appendEvent({
        session: session1,
        event: createEvent({
          author: 'user',
          content: createUserContent('Hi! My dog is named Fido.'),
        }),
      });
      await runner.sessionService.appendEvent({
        session: session1,
        event: createEvent({
          author: 'e2e_memory_agent',
          content: {
            role: 'model',
            parts: [{text: 'I will remember that your dog is named Fido.'}],
          },
        }),
      });

      await runner.memoryService!.addSessionToMemory(session1);

      const session2 = await runner.sessionService.createSession({
        appName: 'e2e_memory_test',
        userId: 'test_user',
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session2.id,
        newMessage: createUserContent(
          'Please answer: What is the name of my dog? You must call the load_memory function to find the answer.',
        ),
      })) {
        const text = event.content?.parts?.[0]?.text;
        if (event.author === 'e2e_memory_agent' && text) {
          finalResponse += text;
        }
      }

      // Check the output
      expect(finalResponse.toLowerCase()).toContain('fido');
    },
    30000,
  );
});
