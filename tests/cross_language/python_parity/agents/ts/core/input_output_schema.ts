/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/core/input_output_schema.
 *
 * Ported as literally as the two APIs allow: same agent names, same schema
 * field names and descriptions, same instruction text. Divergence in the
 * transcript should come from the runtimes, not from the agent definition.
 *
 * One structural difference is forced by the APIs. Python declares the
 * structured agent in `sub_agents` and `LlmAgent.__init__` auto-wraps any
 * sub-agent whose `mode` is `single_turn`/`task` in an `AgentTool` (and drops
 * it from the transfer targets). adk-js does no such wrapping — `mode` there
 * only selects how an agent behaves as a *workflow node* — so the wrapping is
 * written out by hand with `AgentTool`, which is what Python ends up building.
 */
import {AgentTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const CityQuery = z.object({
  city: z
    .string()
    .describe('The name of the city to query weather for, e.g. San Jose'),
});

const WeatherInfo = z.object({
  temperature: z.string().describe('The temperature in Celsius'),
  conditions: z.string().describe('The weather condition, e.g. Sunny'),
});

const weatherAgent = new LlmAgent({
  name: 'weather_agent',
  model: PARITY_MODEL,
  mode: 'single_turn',
  inputSchema: CityQuery,
  outputSchema: WeatherInfo,
  instruction: `Provide weather information for the requested city.

For San Jose, return temperature: 26 C, conditions: Sunny.
For Cupertino, return temperature: 16 C, conditions: Foggy.
For any other city, return temperature: unknown, conditions: unknown.
`,
});

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: PARITY_MODEL,
  instruction: `You are a helpful weather concierge assistant. Use the weather_agent tool to get weather information for the user's city, and then answer the user in a friendly manner.
`,
  tools: [new AgentTool({agent: weatherAgent})],
});
