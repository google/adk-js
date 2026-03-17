/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  InMemoryRunner,
  LlmAgent,
  PRELOAD_MEMORY,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('PreloadMemoryTool Integration', () => {
  it('should preload memory into llmRequest system instructions', async () => {
    let capturedInstruction = '';

    const agent = new LlmAgent({
      name: 'memory_agent',
      description: 'Answers questions from preloaded memory.',
      instruction: 'Answer questions about the user using memory.',
      tools: [PRELOAD_MEMORY],
      beforeModelCallback: async ({request}) => {
        if (request.config?.systemInstruction) {
          capturedInstruction += request.config.systemInstruction.toString();
        }
        return undefined;
      },
    });

    agent.model = new GeminiWithMockResponses([
      // First model response
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Your favorite color is green.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_memory_app',
    });

    // We define a mock memory session
    const memorySession = await runner.sessionService.createSession({
      appName: 'test_memory_app',
      userId: 'test_user',
    });

    // Create some events for memory
    await runner.sessionService.appendEvent({
      session: memorySession,
      event: createEvent({
        author: 'user',
        content: createUserContent('My favorite color is green.'),
      }),
    });
    // Now we add the session context to memory
    await runner.memoryService!.addSessionToMemory(memorySession);

    const session = await runner.sessionService.createSession({
      appName: 'test_memory_app',
      userId: 'test_user',
    });

    let finalResponse = '';

    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('What is my favorite color?'),
    })) {
      if (event.author === 'memory_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) finalResponse += text;
      }
    }

    expect(capturedInstruction).toContain('favorite color is green');
    expect(capturedInstruction).toContain('<PAST_CONVERSATIONS>');
    expect(finalResponse).toContain('Your favorite color is green.');
  });
});
