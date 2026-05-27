/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

interface ToolResult {
  status: 'success' | 'error';
  report?: string;
  error_message?: string;
}

async function get_weather({city}: {city: string}): Promise<ToolResult> {
  if (city.toLowerCase() === 'new york') {
    return {
      'status': 'success',
      'report':
        'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
    };
  } else {
    return {
      'status': 'error',
      'error_message': `Weather information for '${city}' is not available.`,
    };
  }
}

const getWeatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Retrieves the current weather report for a specified city.',
  parameters: z.object({
    city: z.string().describe('The name of the city.'),
  }),
  execute: get_weather,
});

export const rootAgent = new LlmAgent({
  name: 'weather_time_agent',
  model: 'gemini-2.5-flash',
  description: 'Agent to answer questions about weather in a city.',
  instruction:
    'You are a helpful agent who can answer user questions about weather in a city.',
  tools: [getWeatherTool],
});
