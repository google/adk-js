/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {FunctionTool, LlmAgent, LoopAgent} from '@google/adk';
import {z} from 'zod';

function getRandomArbitrary(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

const getTemperatureTool = new FunctionTool({
  name: 'get_temperature',
  description: 'Get the temperature from the environment.',
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const temperature = getRandomArbitrary(30, 40);

    console.log('Current temperature is: ', temperature);

    return temperature;
  },
});

const notifyUserTool = new FunctionTool({
  name: 'notify_user',
  description: 'Notify the user if temperature is too high.',
  parameters: z.object({
    temperature: z.number().describe('The temperature.'),
    threshold: z.number().describe('The threshold.'),
  }),
  execute: ({
    temperature,
    threshold,
  }: {
    temperature: number;
    threshold: number;
  }) => {
    console.log(
      `[NOTIFICATION]: Temperature ${
        temperature
      } is too high! Threshold is ${threshold}.`,
    );
  },
});

const monitorTemperatureAgent = new LlmAgent({
  name: 'monitor_temperature_agent',
  model: 'gemini-2.5-flash',
  description:
    'An agent that continuously monitors the temperature and alerts the user if temperature is too high.',
  instruction:
    'You are an agent that continuously monitors the temperature and alerts the user if the temperature is too high. Threshold is provided by the user.',
  tools: [getTemperatureTool, notifyUserTool],
});

export const rootAgent = new LoopAgent({
  name: 'root_agent',
  description:
    'An agent that continuously monitors the temperature and alerts the user if temperature is too high.',
  maxIterations: 5,
  subAgents: [monitorTemperatureAgent],
});
