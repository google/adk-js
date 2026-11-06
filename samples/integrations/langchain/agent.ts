/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LangChain tool adapter (`LangchainTool`)
 * ../../../docs/guides/integrations/langchain/index.md
 *
 * An `LlmAgent` using LangChain tools adapted through `LangchainTool` from
 * `@google/adk-integrations`. This sample demonstrates:
 *   - Wrapping a structured tool with a Zod parameter schema (`unit_converter`).
 *   - Wrapping a simple convention-based tool (`word_counter`).
 *
 * Prerequisites:
 *   export GEMINI_API_KEY="your-api-key"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/langchain/agent.ts
 * Try "How many miles is 42 kilometers, and how many words are in this question?".
 */

import {LlmAgent} from '@google/adk';
import {LangchainTool} from '@google/adk-integrations';
import {z} from 'zod';

export const unitConverterTool = new LangchainTool({
  tool: {
    name: 'unit_converter',
    description: 'Converts between distance, weight, and temperature units.',
    schema: z.object({
      value: z.number().describe('The numeric value to convert.'),
      fromUnit: z
        .enum(['km', 'miles', 'kg', 'lbs', 'celsius', 'fahrenheit'])
        .describe('The source measurement unit.'),
      toUnit: z
        .enum(['km', 'miles', 'kg', 'lbs', 'celsius', 'fahrenheit'])
        .describe('The target measurement unit.'),
    }),
    invoke: async ({
      value,
      fromUnit,
      toUnit,
    }: {
      value: number;
      fromUnit: string;
      toUnit: string;
    }) => {
      let converted: number | undefined;
      if (fromUnit === 'km' && toUnit === 'miles') {
        converted = value * 0.621371;
      } else if (fromUnit === 'miles' && toUnit === 'km') {
        converted = value * 1.60934;
      } else if (fromUnit === 'kg' && toUnit === 'lbs') {
        converted = value * 2.20462;
      } else if (fromUnit === 'lbs' && toUnit === 'kg') {
        converted = value * 0.453592;
      } else if (fromUnit === 'celsius' && toUnit === 'fahrenheit') {
        converted = (value * 9) / 5 + 32;
      } else if (fromUnit === 'fahrenheit' && toUnit === 'celsius') {
        converted = ((value - 32) * 5) / 9;
      } else if (fromUnit === toUnit) {
        converted = value;
      }

      if (converted === undefined) {
        return {
          error: `Cannot convert from ${fromUnit} to ${toUnit}. Incompatible units.`,
        };
      }

      return {
        value,
        fromUnit,
        toUnit,
        result: Math.round(converted * 1000) / 1000,
      };
    },
  },
});

export const wordCounterTool = new LangchainTool({
  tool: {
    name: 'word_counter',
    description: 'Counts the words and characters in a string.',
    args: {
      text: {type: 'string', description: 'The text to analyze.'},
    },
    run: async ({text}) => {
      const content = typeof text === 'string' ? text : '';
      const words = content.trim().split(/\s+/).filter(Boolean).length;
      return {
        words,
        characters: content.length,
      };
    },
  },
});

export const rootAgent = new LlmAgent({
  name: 'langchain_assistant',
  model: 'gemini-flash-latest',
  description:
    'An assistant that uses LangChain tools to convert units and analyze text.',
  instruction:
    'You are a helpful assistant. Use unit_converter when the user asks to ' +
    'convert measurements, and word_counter when asked about text length or ' +
    'word counts.',
  tools: [unitConverterTool, wordCounterTool],
});
