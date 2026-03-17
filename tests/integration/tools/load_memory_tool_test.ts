/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, LlmAgent, LOAD_MEMORY} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {GeminiWithMockResponses} from '../agents/test_case_utils.js';

describe('LoadMemoryTool Integration', () => {
  it('should process load_memory function calls and answer using memory', async () => {
    const agent = new LlmAgent({
      name: 'memory_agent',
      description: 'Answers questions from memory.',
      instruction: 'Answer questions about the user using memory.',
      tools: [LOAD_MEMORY],
    });

    agent.model = new GeminiWithMockResponses([
      // First model response requests to load memory
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'load_memory',
                    args: {query: 'favorite color'},
                  },
                },
              ],
            },
          },
        ],
      },
      // Second model response happens after the tool provides the content
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Your favorite color is blue.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_memory_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_memory_app',
      userId: 'test_user',
    });

    // Now we add a session to memory
    await runner.memoryService!.addSessionToMemory(session);
    await runner
      .runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent('What is my favorite color?'),
      })
      .next();

    let finalResponse = '';
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent(
        'Based on memory, what is my favorite color?',
      ),
    })) {
      if (event.author === 'memory_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) finalResponse += text;
      }
    }

    expect(finalResponse).toContain('Your favorite color is blue.');
  });
});
