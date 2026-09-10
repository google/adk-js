/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude: function calling
 *
 * Tools reach Claude as its own `tool_use` / `tool_result` blocks, converted
 * from the same `FunctionTool` every other ADK provider takes — so a tool
 * written for Gemini needs no changes to run here.
 *
 * The model is constructed rather than named, which is how you set anything the
 * bare name cannot carry: the API key, the token ceiling, a proxy base URL.
 *
 * REQUIRES an Anthropic API key. Set ANTHROPIC_API_KEY, then:
 *   npm run sample -- samples/claude/tools/agent.ts
 *
 * Try: "Which is warmer right now, Oslo or Nairobi?"
 */

import {FunctionTool, LlmAgent} from '@google/adk';
import {AnthropicLlm} from '@google/adk-integrations';
import {z} from 'zod';

/** Stands in for a weather API, so the sample runs without a second key. */
const FORECASTS: Record<string, {celsius: number; sky: string}> = {
  'nairobi': {celsius: 26, sky: 'partly cloudy'},
  'oslo': {celsius: 4, sky: 'overcast'},
  'tokyo': {celsius: 18, sky: 'clear'},
};

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Look up the current weather in a city.',
  parameters: z.object({
    city: z.string().describe('The city to look up, e.g. "Oslo".'),
    unit: z
      .enum(['celsius', 'fahrenheit'])
      .default('celsius')
      .describe('The unit to report the temperature in.'),
  }),
  execute: async ({city, unit}) => {
    const forecast = FORECASTS[city.toLowerCase()];
    if (!forecast) {
      return {error: `No forecast for ${city}.`};
    }
    const degrees =
      unit === 'fahrenheit'
        ? Math.round(forecast.celsius * 1.8 + 32)
        : forecast.celsius;
    return {city, sky: forecast.sky, degrees, unit};
  },
});

export const rootAgent = new LlmAgent({
  name: 'claude_weather_agent',
  model: new AnthropicLlm({
    model: 'claude-sonnet-4-5-20250929',
    // Defaults to ANTHROPIC_API_KEY; passed here to show where it goes.
    apiKey: process.env['ANTHROPIC_API_KEY'],
    maxTokens: 2048,
  }),
  description: 'A weather assistant powered by Claude.',
  instruction:
    'You are a weather assistant. Use get_weather for every city the user ' +
    'asks about, then answer in one short sentence per city.',
  tools: [getWeather],
});
