/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/tools/parallel_functions.
 *
 * Sample agent for testing parallel function calling.
 *
 * The sleeps are kept because they are the sample: adk-python awaits the whole
 * batch of calls with `asyncio.gather`, so three 2s weather calls take ~2s,
 * while adk-js runs the batch in a sequential `for await` loop
 * (core/src/agents/functions.ts:344) and takes ~6s. Timing is not compared,
 * but the state each tool writes is, and that is where the two execution
 * models show up.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

/** Non-blocking equivalent of Python's `await asyncio.sleep(seconds)`. */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

interface WeatherEntry {
  temp: number;
  condition: string;
  humidity: number;
  note?: string;
}

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: z.object({
    city: z.string().describe('The name of the city to get weather for.'),
  }),
  execute: async ({city}, toolContext) => {
    // Simulate some async processing time (non-blocking)
    await sleep(2);

    // Mock weather data
    const weatherData: Record<string, WeatherEntry> = {
      'New York': {temp: 72, condition: 'sunny', humidity: 45},
      'London': {temp: 60, condition: 'cloudy', humidity: 80},
      'Tokyo': {temp: 68, condition: 'rainy', humidity: 90},
      'San Francisco': {temp: 65, condition: 'foggy', humidity: 85},
      'Paris': {temp: 58, condition: 'overcast', humidity: 70},
      'Sydney': {temp: 75, condition: 'sunny', humidity: 60},
    };

    const result: WeatherEntry = weatherData[city] ?? {
      temp: 70,
      condition: 'unknown',
      humidity: 50,
      note: `Weather data not available for ${city}, showing default values`,
    };

    // Store in context for testing thread safety
    const requests =
      (toolContext?.state.get('weather_requests') as unknown[] | undefined) ??
      [];
    toolContext?.state.set('weather_requests', [...requests, {city, result}]);

    return {
      city,
      temperature: result.temp,
      condition: result.condition,
      humidity: result.humidity,
      ...(result.note !== undefined ? {note: result.note} : {}),
    };
  },
});

const getCurrencyRate = new FunctionTool({
  name: 'get_currency_rate',
  description: 'Get the exchange rate between two currencies.',
  parameters: z.object({
    from_currency: z
      .string()
      .describe("The source currency code (e.g., 'USD')."),
    to_currency: z.string().describe("The target currency code (e.g., 'EUR')."),
  }),
  execute: async ({from_currency, to_currency}, toolContext) => {
    // Simulate async processing time
    await sleep(1.5);

    // Mock exchange rates
    const rates: Record<string, number> = {
      'USD,EUR': 0.85,
      'USD,GBP': 0.75,
      'USD,JPY': 110.0,
      'EUR,USD': 1.18,
      'EUR,GBP': 0.88,
      'GBP,USD': 1.33,
      'GBP,EUR': 1.14,
      'JPY,USD': 0.009,
    };

    const rate = rates[`${from_currency},${to_currency}`] ?? 1.0;

    // Store in context for testing thread safety
    const requests =
      (toolContext?.state.get('currency_requests') as unknown[] | undefined) ??
      [];
    toolContext?.state.set('currency_requests', [
      ...requests,
      {from: from_currency, to: to_currency, rate},
    ]);

    return {
      from_currency,
      to_currency,
      exchange_rate: rate,
    };
  },
});

const calculateDistance = new FunctionTool({
  name: 'calculate_distance',
  description: 'Calculate the distance between two cities.',
  parameters: z.object({
    city1: z.string().describe('The first city.'),
    city2: z.string().describe('The second city.'),
  }),
  execute: async ({city1, city2}, toolContext) => {
    // Simulate async processing time (non-blocking)
    await sleep(1);

    // Mock distances (in kilometers)
    const cityCoords: Record<string, [number, number]> = {
      'New York': [40.7128, -74.006],
      'London': [51.5074, -0.1278],
      'Tokyo': [35.6762, 139.6503],
      'San Francisco': [37.7749, -122.4194],
      'Paris': [48.8566, 2.3522],
      'Sydney': [-33.8688, 151.2093],
    };

    // Simple distance calculation (mock)
    let distance: number;
    const coord1 = cityCoords[city1];
    const coord2 = cityCoords[city2];
    if (coord1 && coord2) {
      // Simplified distance calculation
      distance = Math.trunc(
        Math.sqrt((coord1[0] - coord2[0]) ** 2 + (coord1[1] - coord2[1]) ** 2) *
          111, // rough km conversion
      );
    } else {
      distance = 5000; // default distance
    }

    // Store in context for testing thread safety
    const requests =
      (toolContext?.state.get('distance_requests') as unknown[] | undefined) ??
      [];
    toolContext?.state.set('distance_requests', [
      ...requests,
      {city1, city2, distance},
    ]);

    return {
      city1,
      city2,
      distance_km: distance,
      distance_miles: Math.trunc(distance * 0.621371),
    };
  },
});

const getPopulation = new FunctionTool({
  name: 'get_population',
  description: 'Get population information for multiple cities.',
  parameters: z.object({
    cities: z.array(z.string()).describe('A list of city names.'),
  }),
  execute: async ({cities}, toolContext) => {
    // Simulate async processing time proportional to number of cities
    // (non-blocking)
    await sleep(cities.length * 0.5);

    // Mock population data
    const populations: Record<string, number> = {
      'New York': 8336817,
      'London': 9648110,
      'Tokyo': 13960000,
      'San Francisco': 873965,
      'Paris': 2161000,
      'Sydney': 5312163,
    };

    const results: Record<string, number> = {};
    for (const city of cities) {
      results[city] = populations[city] ?? 1000000; // default 1M if not found
    }

    // Store in context for testing thread safety
    const requests =
      (toolContext?.state.get('population_requests') as
        | unknown[]
        | undefined) ?? [];
    toolContext?.state.set('population_requests', [
      ...requests,
      {cities, results},
    ]);

    return {
      populations: results,
      total_population: Object.values(results).reduce((a, b) => a + b, 0),
      cities_count: cities.length,
    };
  },
});

export const rootAgent = new LlmAgent({
  name: 'parallel_function_test_agent',
  model: PARITY_MODEL,
  description:
    'Agent for testing parallel function calling performance and thread' +
    ' safety.',
  instruction: `
    You are a helpful assistant that can provide information about weather, currency rates,
    distances between cities, and population data. You have access to multiple tools and
    should use them efficiently.

    When users ask for information about multiple cities or multiple types of data,
    you should call multiple functions in parallel to provide faster responses.

    For example:
    - If asked about weather in multiple cities, call get_weather for each city in parallel
    - If asked about weather and currency rates, call both functions in parallel
    - If asked to compare cities, you might need weather, population, and distance data in parallel

    Always aim to be efficient and call multiple functions simultaneously when possible.
    Be informative and provide clear, well-structured responses.
  `,
  tools: [getWeather, getCurrencyRate, calculateDistance, getPopulation],
});
