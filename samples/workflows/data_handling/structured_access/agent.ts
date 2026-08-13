/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Access structured data in agents
 * https://adk.dev/graphs/data-handling/#access-structured-data-in-agents
 *
 * Two data-selection forms are available inside an agent instruction:
 *
 *   {Class.field}                    reads a field off THIS node's input
 *   <Class.field from source_node>   reads a field off a named predecessor's
 *                                    output — more restrictive, and unambiguous
 *                                    when several upstream nodes share a field
 *
 * Both are distinct from `{state_key}`, which reads session state. The `Class.`
 * prefix is documentation only: resolution uses the field name after the dot.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/data_handling/structured_access/agent.ts
 */

import {LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

const cityTimeSchema = z.object({
  timeInfo: z.string().describe('Time information.'),
  city: z.string().describe('City name.'),
});
type CityTime = z.infer<typeof cityTimeSchema>;

const cityGeneratorAgent = new LlmAgent({
  name: 'city_generator_agent',
  model: 'gemini-flash-latest',
  instruction: 'Return the name of a random city. Return only the name.',
});

/** Simulates returning the current time in the specified city. */
const lookupTimeFunction = node(
  (_ctx: NodeContext, city: string): CityTime => ({
    timeInfo: '10:10 AM',
    city: city.trim(),
  }),
  {name: 'lookup_time_function', outputSchema: cityTimeSchema},
);

const cityReportAgent = new LlmAgent({
  name: 'city_report_agent',
  model: 'gemini-flash-latest',

  // Data selection based on class and parameter — reads this node's own input:
  // instruction: `Return a sentence in the following format:
  //     It is {CityTime.timeInfo} in {CityTime.city} right now.`,

  // More restrictive data selection, qualified by source node name. Keep the
  // template on ONE line: a model reproduces a line break inside the format
  // string, which splits the answer mid-sentence.
  instruction:
    'Return a sentence in the following format: It is ' +
    '<CityTime.timeInfo from lookup_time_function> in ' +
    '<CityTime.city from lookup_time_function> right now.',
});

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    [
      'START',
      cityGeneratorAgent,
      lookupTimeFunction,
      node(cityReportAgent, {inputSchema: cityTimeSchema}),
    ],
  ],
});
