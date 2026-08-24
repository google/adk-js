/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/core/quickstart.
 *
 * Ported as literally as the two APIs allow: same tool names, same parameter
 * names, same instruction text. Divergence in the transcript should come from
 * the runtimes, not from the agent definition.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Retrieves the current weather report for a specified city.',
  parameters: z.object({
    city: z
      .string()
      .describe(
        'The name of the city for which to retrieve the weather report.',
      ),
  }),
  execute: ({city}) => {
    if (city.toLowerCase() === 'new york') {
      return {
        status: 'success',
        report:
          'The weather in New York is sunny with a temperature of 25 degrees' +
          ' Celsius (77 degrees Fahrenheit).',
      };
    }
    return {
      status: 'error',
      error_message: `Weather information for '${city}' is not available.`,
    };
  },
});

/**
 * Renders `now` the way Python's `strftime("%Y-%m-%d %H:%M:%S %Z%z")` does,
 * e.g. `2026-05-15 12:00:00 EDT-0400`. There is no strftime in JS, so the
 * fields are assembled from two `Intl` formatters.
 */
function formatInZone(now: Date, timeZone: string): string {
  const fields = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(now);
  const get = (type: string) =>
    fields.find((part) => part.type === type)?.value ?? '';

  const offset =
    new Intl.DateTimeFormat('en-US', {timeZone, timeZoneName: 'longOffset'})
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const numericOffset = offset.replace('GMT', '').replace(':', '') || '+0000';

  const hour = get('hour') === '24' ? '00' : get('hour');
  return (
    `${get('year')}-${get('month')}-${get('day')} ` +
    `${hour}:${get('minute')}:${get('second')} ` +
    `${get('timeZoneName')}${numericOffset}`
  );
}

const getCurrentTime = new FunctionTool({
  name: 'get_current_time',
  description: 'Returns the current time in a specified city.',
  parameters: z.object({
    city: z
      .string()
      .describe('The name of the city for which to retrieve the current time.'),
  }),
  execute: ({city}) => {
    if (city.toLowerCase() !== 'new york') {
      return {
        status: 'error',
        error_message: `Sorry, I don't have timezone information for ${city}.`,
      };
    }
    const report = `The current time in ${city} is ${formatInZone(
      new Date(),
      'America/New_York',
    )}`;
    return {status: 'success', report};
  },
});

export const rootAgent = new LlmAgent({
  name: 'weather_time_agent',
  model: PARITY_MODEL,
  description:
    'Agent to answer questions about the time and weather in a city.',
  instruction:
    'I can answer your questions about the time and weather in a city.',
  tools: [getWeather, getCurrentTime],
});
