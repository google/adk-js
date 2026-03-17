/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: z.object({
    city: z.string().describe('The city name'),
  }),
  execute: async ({city}: {city: string}) => {
    return {result: `The weather in ${city} is sunny, 22°C.`};
  },
});

export const rootAgent = new LlmAgent({
  name: 'claude_weather_agent',
  model: 'claude-sonnet-4-5-20250929',
  description: 'A weather assistant powered by Claude.',
  instruction:
    'You are a helpful weather assistant. Use the get_weather tool to answer weather questions. Be concise.',
  tools: [getWeather],
});
