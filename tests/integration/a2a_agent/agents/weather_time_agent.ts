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

async function get_current_time({city}: {city: string}): Promise<ToolResult> {
  if (city.toLowerCase() === 'new york') {
    const tzIdentifier = 'America/New_York';
    try {
      const report = `The current time in ${city} is ${new Date(
        1769756180326,
      ).toLocaleString('en-US', {
        timeZone: tzIdentifier,
      })} ${tzIdentifier}`;
      return {'status': 'success', 'report': report};
    } catch (e) {
      return {
        'status': 'error',
        'error_message': `Error getting time for ${city}: ${e}`,
      };
    }
  } else {
    return {
      'status': 'error',
      'error_message': `Sorry, I don't have timezone information for ${city}.`,
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

const getCurrentTimeTool = new FunctionTool({
  name: 'get_current_time',
  description: 'Returns the current time in a specified city.',
  parameters: z.object({
    city: z.string().describe('The name of the city.'),
  }),
  execute: get_current_time,
});

export const rootAgent = new LlmAgent({
  name: 'weather_time_agent',
  model: 'gemini-2.5-flash',
  description:
    'Agent to answer questions about the time and weather in a city.',
  instruction:
    'You are a helpful agent who can answer user questions about the time and weather in a city.',
  tools: [getWeatherTool, getCurrentTimeTool],
});
