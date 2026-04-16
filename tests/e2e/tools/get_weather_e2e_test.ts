/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const envPath = path.resolve(__dirname, '.env');
const envExists = fs.existsSync(envPath);

if (envExists) {
  dotenv.config({path: envPath});
}

// Check for API keys to skip tests if not available
const hasAKey =
  !!process.env.GEMINI_API_KEY ||
  !!process.env.GOOGLE_GENAI_API_KEY ||
  !!process.env.GOOGLE_CLOUD_PROJECT;

describe.skipIf(!hasAKey)('E2E Weather Tool Test', () => {
  it('should verify that the function call happens and the model outputs text', async () => {
    // Succinct comment: Intent is to test that the agent calls the tool and responds.
    let toolCalled = false;
    const getWeather = new FunctionTool({
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: z.object({city: z.string()}), // Used parameters instead of inputSchema as per FunctionTool definition
      execute: async ({city}: {city: string}) => {
        toolCalled = true;
        console.log(`Function call: get_weather called with city: ${city}`);
        return {city, temp: '72F', condition: 'sunny'};
      },
    });

    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-3-flash-preview',
      instruction:
        'You help with weather questions. Always use the get_weather tool.',
      tools: [getWeather],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'weather_test_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'weather_test_app',
      userId: 'test_user',
    });

    let responseText = '';
    const events = [];
    // Run the agent and collect response text
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('What is the weather in Seattle?'),
    })) {
      events.push(event);
      if (event.author === 'test_agent' && event.content?.parts?.[0]?.text) {
        responseText += event.content.parts[0].text;
      }
    }

    // Verify the function call happened
    expect(toolCalled).toBe(true);
    // Verify the model outputs some kind of text
    expect(responseText).toBeTruthy();
    console.log(`Model output text: ${responseText}`);
    console.log(
      `Structured session events:\n${JSON.stringify(events, null, 2)}`,
    );
  }, 30000);
});
