/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AnthropicLlm,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  StreamingMode,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

describe('E2E AnthropicLlm', () => {
  // Load .env from e2e dir or project root
  for (const rel of [
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', '..', '.env'),
  ]) {
    if (fs.existsSync(rel)) {
      dotenv.config({path: rel});
    }
  }

  const hasKey = !!process.env.ANTHROPIC_API_KEY;

  // -------------------------------------------------------------------------
  // Basic text generation
  // -------------------------------------------------------------------------
  it.skipIf(!hasKey)(
    'should generate a text response with Claude',
    async () => {
      const agent = new LlmAgent({
        name: 'claude_text_agent',
        model: 'claude-sonnet-4-5-20250929',
        instruction: 'You are a helpful assistant. Keep responses very short.',
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_anthropic_test',
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_anthropic_test',
        userId: 'test_user',
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent(
          'What is 2 + 3? Reply with just the number.',
        ),
      })) {
        if (
          event.author === 'claude_text_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      expect(finalResponse).toContain('5');
    },
    30000,
  );

  // -------------------------------------------------------------------------
  // Function calling (tool use)
  // -------------------------------------------------------------------------
  it.skipIf(!hasKey)(
    'should call a function tool and return the result',
    async () => {
      const getWeather = new FunctionTool({
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: z.object({
          city: z.string().describe('The city name'),
        }),
        execute: async ({city}) => {
          return {result: `The weather in ${city} is sunny, 22°C.`};
        },
      });

      const agent = new LlmAgent({
        name: 'claude_tool_agent',
        model: 'claude-sonnet-4-5-20250929',
        instruction:
          'You are a weather assistant. Use the get_weather tool to answer weather questions. Keep responses short.',
        tools: [getWeather],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_anthropic_tool_test',
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_anthropic_tool_test',
        userId: 'test_user',
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent("What's the weather in Seoul?"),
      })) {
        if (
          event.author === 'claude_tool_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      expect(finalResponse.toLowerCase()).toMatch(/sunny|22/);
    },
    30000,
  );

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------
  it.skipIf(!hasKey)(
    'should work with streaming mode',
    async () => {
      const agent = new LlmAgent({
        name: 'claude_stream_agent',
        model: new AnthropicLlm({model: 'claude-sonnet-4-5-20250929'}),
        instruction: 'You are a helpful assistant. Keep responses very short.',
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_anthropic_stream_test',
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_anthropic_stream_test',
        userId: 'test_user',
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent('Say hello in Korean.'),
        runConfig: {streamingMode: StreamingMode.SSE},
      })) {
        if (
          event.author === 'claude_stream_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      expect(finalResponse).toBeTruthy();
      expect(finalResponse.length).toBeGreaterThan(0);
    },
    30000,
  );
});
