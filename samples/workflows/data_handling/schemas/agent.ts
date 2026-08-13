/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Constrain node data with schemas
 * https://adk.dev/graphs/data-handling/#constrain-node-data-with-schemas
 *
 * Schemas constrain what a node accepts and produces. Use a Zod object, or a
 * genai `Schema`.
 *
 * Where the schema goes:
 *   - `LlmAgent.outputSchema` forces the model to answer in that shape.
 *   - `LlmAgent.inputSchema` is only consulted when the agent is exposed as a
 *     tool. Inside a graph, the schema that VALIDATES a node's input belongs on
 *     the node: `node(agent, {inputSchema})`.
 *
 * Agents in a graph must run in `single_turn` (the default) or `task` mode.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/data_handling/schemas/agent.ts
 * Try "SFO to CDG on 2026-03-15 for 2 people".
 */

import {
  FunctionTool,
  LlmAgent,
  node,
  NodeContext,
  WorkflowAgent,
} from '@google/adk';
import {z} from 'zod';

const flightSearchInputSchema = z.object({
  origin: z.string().describe('Origin airport code, e.g. "SFO".'),
  destination: z.string().describe('Destination airport code, e.g. "CDG".'),
  departureDate: z.string().describe('Departure date, e.g. "2026-03-15".'),
  passengers: z.number().describe('Number of passengers.'),
});
type FlightSearchInput = z.infer<typeof flightSearchInputSchema>;

const flightSchema = z.object({
  carrier: z.string(),
  flightNumber: z.string(),
  price: z.number(),
});

const flightSearchOutputSchema = z.object({
  flights: z.array(flightSchema),
  cheapestPrice: z.number(),
});
type FlightSearchOutput = z.infer<typeof flightSearchOutputSchema>;

/** Stands in for a real flight-search API. */
const searchFlightsApi = new FunctionTool({
  name: 'search_flights_api',
  description: 'Searches available flights for a route and date.',
  parameters: flightSearchInputSchema,
  execute: ({origin, destination}) => [
    {
      carrier: 'AF',
      flightNumber: `AF${origin.length}${destination.length}0`,
      price: 812.4,
    },
    {
      carrier: 'UA',
      flightNumber: `UA${origin.length}${destination.length}1`,
      price: 947.0,
    },
  ],
});

// Turns the free-text request into the structured node input the searcher
// expects. In a real app this would itself be an extraction agent.
const parseRequest = node(
  (_ctx: NodeContext, nodeInput: string): FlightSearchInput => {
    const codes = nodeInput.toUpperCase().match(/\b[A-Z]{3}\b/g) ?? [];
    const date = nodeInput.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const passengers = Number(
      nodeInput.match(/(\d+)\s*(people|pax|passengers?)/i)?.[1],
    );
    return {
      origin: codes[0] ?? 'SFO',
      destination: codes[1] ?? 'CDG',
      departureDate: date ?? '2026-03-15',
      passengers: Number.isFinite(passengers) ? passengers : 1,
    };
  },
  {name: 'parse_request', outputSchema: flightSearchInputSchema},
);

const flightSearcher = new LlmAgent({
  name: 'flight_searcher',
  model: 'gemini-flash-latest',
  mode: 'single_turn',
  instruction:
    'Search for available flights with the search_flights_api tool and report ' +
    'every flight it returns plus the cheapest price.',
  inputSchema: flightSearchInputSchema,
  outputSchema: flightSearchOutputSchema,
  tools: [searchFlightsApi],
});

const renderResults = node(
  (_ctx: NodeContext, results: FlightSearchOutput) =>
    `Cheapest: $${results.cheapestPrice}\n` +
    results.flights
      .map((f) => `  ${f.carrier} ${f.flightNumber} — $${f.price}`)
      .join('\n'),
  {name: 'render_results', inputSchema: flightSearchOutputSchema},
);

export const rootAgent = new WorkflowAgent({
  name: 'flight_workflow',
  edges: [
    [
      'START',
      parseRequest,
      // The graph-level input contract for the agent node.
      node(flightSearcher, {inputSchema: flightSearchInputSchema}),
      renderResults,
    ],
  ],
});
