/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/tools/function_tools.
 *
 * Python registers bare callables and derives the declaration from the type
 * hints plus docstring; TS spells the same declaration out with zod. Names,
 * parameter names and descriptions are kept identical so only the framework
 * can account for a difference.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const generateRandomNumber = new FunctionTool({
  name: 'generate_random_number',
  description:
    'Generates a random integer between 0 and max_value (inclusive).',
  parameters: z.object({
    max_value: z
      .number()
      .int()
      .default(100)
      .describe('The upper limit for the random number.'),
  }),
  // The upstream sample returns a growing counter under `PYTEST_CURRENT_TEST`
  // so its own unit tests stay deterministic. The parity harness never sets
  // that variable, so only the random branch is reachable and is all that is
  // ported here.
  execute: ({max_value}) => Math.floor(Math.random() * (max_value + 1)),
});

const isEven = new FunctionTool({
  name: 'is_even',
  description: 'Checks if a given number is even.',
  parameters: z.object({
    number: z.number().int().describe('The number to check.'),
  }),
  execute: ({number}) => number % 2 === 0,
});

// The Python sample passes neither `instruction` nor `description`; leaving
// them unset here keeps the two system prompts comparable.
export const rootAgent = new LlmAgent({
  name: 'function_tools',
  model: PARITY_MODEL,
  tools: [generateRandomNumber, isEven],
});
