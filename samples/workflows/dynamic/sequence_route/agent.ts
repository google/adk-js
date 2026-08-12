/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sequence route
 * https://adk.dev/graphs/dynamic/#sequence-route
 * https://adk.dev/graphs/dynamic/#data-handling (the `CityTime` variant)
 *
 * A sequential route in a dynamic workflow is just awaiting `ctx.runNode()`
 * calls one after another — each finishes before the next starts. Schemas work
 * the same as in a graph: attach them to the nodes you run.
 *
 * REQUIRES an API key (two nodes call a live model). Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/dynamic/sequence_route/agent.ts
 */

import {LlmAgent, node, NodeContext, WorkflowAgent} from '@google/adk';
import {z} from 'zod';

const cityTimeSchema = z.object({
  timeInfo: z.string().describe('Time information.'),
  city: z.string().describe('City name.'),
});
type CityTime = z.infer<typeof cityTimeSchema>;

const cityGeneratorAgent = node(
  new LlmAgent({
    name: 'city_generator_agent',
    model: 'gemini-flash-latest',
    instruction: 'Return the name of a random city. Return only the name.',
  }),
);

/** Simulates returning the current time in a specified city. */
const cityTimeFunction = node(
  (_ctx: NodeContext, city: string): CityTime => ({
    timeInfo: '10:10 AM',
    city: city.trim(),
  }),
  {name: 'city_time_function', outputSchema: cityTimeSchema},
);

const cityReportAgent = node(
  new LlmAgent({
    name: 'city_report_agent',
    model: 'gemini-flash-latest',
    instruction: 'Output the data provided by the previous node as a sentence.',
  }),
  {inputSchema: cityTimeSchema},
);

const cityWorkflow = node(
  async (ctx: NodeContext) => {
    const city = await ctx.runNode(cityGeneratorAgent);
    const cityTime = await ctx.runNode(cityTimeFunction, city.output);
    const reportText = await ctx.runNode(cityReportAgent, cityTime.output);

    return reportText.output;
  },
  {name: 'city_workflow', rerunOnResume: true},
);

export const rootAgent = new WorkflowAgent({
  name: 'root_agent',
  edges: [['START', cityWorkflow]],
});
