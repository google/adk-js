/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {FunctionTool, GoogleSearchTool, LlmAgent, ParallelAgent} from '@google/adk';
import {z} from 'zod';

function getRandomArbitrary(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

const getWeatherTemperatureTool = new FunctionTool({
  name: 'get_weather_temperature',
  description:
      'Retrieves the current templature in celsius for a specified city.',
  parameters: z.object({
    city: z.string().describe('The name of the city.'),
  }),
  execute: ({city}: {city: string}) => {
    const temperature = Math.floor(getRandomArbitrary(15, 35));

    return `Temperature in ${city} is ${temperature} Celsius.`;
  },
});

export const rootAgent = new ParallelAgent({
  name: 'parallel_agent',
  description: 'A parallel agent that runs multiple sub-agents in parallel.',
  subAgents: [
    new LlmAgent({
      name: 'google_search_agent',
      model: 'gemini-2.5-flash',
      description:
          'An agent whose job it is to perform Google search queries and answer questions about the results.',
      instruction:
          'You are an agent whose job is to perform Google search query and return summary for the result maximum containing 300 characters.',
      tools: [new GoogleSearchTool()],
    }),
    new LlmAgent({
      name: 'get_weather_agent',
      model: 'gemini-2.5-flash',
      description: 'Retrieves the current weather report for a specified city.',
      instruction:
          'You are responsible for retrieving the current weather temperature for a city from the user request. You should not ask for additional information.',
      tools: [getWeatherTemperatureTool],
    }),
  ],
});
