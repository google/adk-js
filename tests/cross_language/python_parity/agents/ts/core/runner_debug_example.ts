/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/core/runner_debug_example.
 *
 * Ported as literally as the two APIs allow: same tool names, same parameter
 * names, same mock data, same instruction text. Divergence in the transcript
 * should come from the runtimes, not from the agent definition.
 *
 * The sample's `main.py` is a tour of `Runner.run_debug()`, a Python-only
 * convenience wrapper; the agent itself is what the parity run measures, and
 * it ports unchanged. The Python agent pins `gemini-2.5-flash-lite`, which the
 * harness overrides on both sides so the two runs share one model.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const weatherData: Record<string, string> = {
  'San Francisco': 'Foggy, 15°C (59°F)',
  'New York': 'Sunny, 22°C (72°F)',
  'London': 'Rainy, 12°C (54°F)',
  'Tokyo': 'Clear, 25°C (77°F)',
  'Paris': 'Cloudy, 18°C (64°F)',
};

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Get weather information for a city.',
  parameters: z.object({
    city: z.string().describe('Name of the city to get weather for.'),
  }),
  execute: ({city}, toolContext) => {
    // Store query history in session state
    const queries = toolContext?.state.get('weather_queries') as
      | string[]
      | undefined;
    toolContext?.state.set(
      'weather_queries',
      queries === undefined ? [city] : [...queries, city],
    );

    // Mock weather data for demonstration
    return (
      weatherData[city] ??
      `Weather data not available for ${city}. Try a major city.`
    );
  },
});

const prices: Record<string, string> = {
  GOOGL: '175.50 USD',
  AAPL: '225.00 USD',
  MSFT: '420.00 USD',
  AMZN: '190.00 USD',
  NVDA: '125.00 USD',
};

const getStockPrice = new FunctionTool({
  name: 'get_stock_price',
  description: 'Get the current stock price for a given ticker symbol.',
  parameters: z.object({
    ticker: z
      .string()
      .describe('Stock ticker symbol (e.g., GOOGL, AAPL, MSFT).'),
  }),
  execute: ({ticker}) => {
    const symbol = ticker.toUpperCase();
    if (symbol in prices) {
      return `Price for ${symbol}: ${prices[symbol]}`;
    }
    return `Stock ticker ${symbol} not found in database.`;
  },
});

export const rootAgent = new LlmAgent({
  model: PARITY_MODEL,
  name: 'agent',
  description: 'A helpful assistant demonstrating run_debug() helper method',
  instruction: `You are a helpful assistant that can:
    1. Provide weather information for major cities
    2. Provide stock prices for major tech companies
    3. Remember previous queries in the conversation

    When users ask about weather, use the get_weather tool.
    When users ask for stock prices, use the get_stock_price tool.
    Be friendly and conversational.`,
  tools: [getWeather, getStockPrice],
});
