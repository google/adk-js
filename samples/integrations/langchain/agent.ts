/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LangChain Tool (`LangchainTool`)
 * ../../../docs/guides/integrations/langchain/index.md
 *
 * An `LlmAgent` equipped with `LangchainTool` adapters from
 * `@google/adk-integrations`, demonstrating both a Zod-typed `invoke` tool and
 * a convention-based `run` tool with custom name and description overrides.
 *
 * Prerequisites:
 *   export GEMINI_API_KEY="your-gemini-api-key"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/langchain/agent.ts
 * Try "Convert 72 Fahrenheit to Celsius and look up the units reference."
 */

import {LlmAgent} from '@google/adk';
import {LangchainTool} from '@google/adk-integrations';
import {z} from 'zod';

const TEMPERATURE_UNITS = ['celsius', 'fahrenheit', 'kelvin'] as const;
type TemperatureUnit = (typeof TEMPERATURE_UNITS)[number];

function toCelsius(value: number, unit: TemperatureUnit): number {
  switch (unit) {
    case 'celsius':
      return value;
    case 'fahrenheit':
      return ((value - 32) * 5) / 9;
    case 'kelvin':
      return value - 273.15;
  }
}

function fromCelsius(celsius: number, unit: TemperatureUnit): number {
  switch (unit) {
    case 'celsius':
      return celsius;
    case 'fahrenheit':
      return (celsius * 9) / 5 + 32;
    case 'kelvin':
      return celsius + 273.15;
  }
}

export const convertTemperatureTool = new LangchainTool({
  tool: {
    name: 'convert_temperature',
    description:
      'Converts a temperature value between Celsius, Fahrenheit, and Kelvin.',
    schema: z.object({
      value: z.number().describe('Numeric temperature value to convert.'),
      fromUnit: z.enum(TEMPERATURE_UNITS).describe('Source temperature unit.'),
      toUnit: z.enum(TEMPERATURE_UNITS).describe('Target temperature unit.'),
    }),
    invoke: async ({
      value,
      fromUnit,
      toUnit,
    }: {
      value: number;
      fromUnit: TemperatureUnit;
      toUnit: TemperatureUnit;
    }) => {
      const converted = fromCelsius(toCelsius(value, fromUnit), toUnit);
      return {
        input: {value, unit: fromUnit},
        output: {
          value: Math.round(converted * 100) / 100,
          unit: toUnit,
        },
      };
    },
  },
});

const REFERENCE_NOTES: Record<string, string> = {
  units:
    'SI uses kelvin for thermodynamic temperature and Celsius for everyday measurements.',
  boiling: 'Water boils at 100 C (212 F, 373.15 K) at standard pressure.',
  freezing: 'Water freezes at 0 C (32 F, 273.15 K) at standard pressure.',
};

export const lookupReferenceTool = new LangchainTool(
  {
    name: 'raw_reference_tool',
    description: 'Original raw description replaced by constructor options.',
    args: {
      topic: {
        type: 'string',
        description: 'Topic keyword such as units, boiling, or freezing.',
      },
    },
    run: ({topic}: {topic: string}) => {
      const normalized = topic.trim().toLowerCase();
      return (
        REFERENCE_NOTES[normalized] ??
        `No reference note found for "${topic}". Available topics: ${Object.keys(REFERENCE_NOTES).join(', ')}.`
      );
    },
  },
  {
    name: 'lookup_temperature_reference',
    description:
      'Looks up short scientific reference notes for topics like units, boiling, or freezing.',
  },
);

export const rootAgent = new LlmAgent({
  name: 'langchain_tools_assistant',
  model: 'gemini-flash-latest',
  description:
    'Answers temperature conversion and scientific reference questions using LangChain-style tools.',
  instruction:
    'You are a helpful science assistant. Use convert_temperature for ' +
    'temperature conversions and lookup_temperature_reference when asked for ' +
    'reference facts.',
  tools: [convertTemperatureTool, lookupReferenceTool],
});
