/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, LlmAgent, type Skill, SkillToolset} from '@google/adk';
import {z} from 'zod';

const getHumidityTool = new FunctionTool({
  name: 'get_humidity',
  description: 'Returns the humidity for a given location.',
  parameters: z.object({
    location: z.string().describe('The location to get the humidity for.'),
  }),
  execute: ({location}) => `The humidity in ${location} is 55%.`,
});

const getWindSpeedTool = new FunctionTool({
  name: 'get_wind_speed',
  description: 'Returns the wind speed for a given location.',
  parameters: z.object({
    location: z.string().describe('The location to get the humidity for.'),
  }),
  execute: ({location}) => `The wind speed in ${location} is 10 mph.`,
});

const weatherSkill: Skill = {
  frontmatter: {
    name: 'weather-skill',
    description: 'A weather skill that can provide weather information.',
    metadata: {'adk_additional_tools': ['get_wind_speed', 'get_humidity']},
  },
  instructions: `
    Step 1: Check 'references/weather_info.md' for the current weather.
    Step 2: If humidity is requested, use the \`get_humidity\` tool with the \`location\` argument from the user query.
    Step 3: If wind speed is requested, use the \`get_wind_speed\` tool with the \`location\` argument from the user query.
    Step 4: Provide the update to the user in a concise form.
  `,
  resources: {
    references: {
      'weather_info.md': `
        Weather Information
        - **Location:** San Francisco, CA
        - **Temperature:** 68°F (20°C)
        - **Condition:** Partly Cloudy
        - **Humidity:** 55%
        - **Wind Speed:** 10 mph`,
    },
  },
};

const mySkillToolset = new SkillToolset([weatherSkill], {
  additionalTools: [getWindSpeedTool, getHumidityTool],
});

export const rootAgent = new LlmAgent({
  model: 'gemini-2.5-flash',
  name: 'skill_user_agent',
  description: 'An agent that can use specialized skills.',
  tools: [mySkillToolset],
});
