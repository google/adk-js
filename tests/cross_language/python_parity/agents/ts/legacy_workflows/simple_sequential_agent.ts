/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/legacy_workflows/simple_sequential_agent.
 *
 * `roll_agent` then `prime_agent`, wired with the legacy `SequentialAgent`.
 * Unlike the multi-agent samples there is no transfer here: the ordering comes
 * from the workflow agent, not from the model.
 */
import {FunctionTool, LlmAgent, SequentialAgent} from '@google/adk';
import {HarmBlockThreshold, HarmCategory} from '@google/genai';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

// --- Roll Die Sub-Agent ---
const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Roll a die and return the rolled result.',
  parameters: z.object({
    sides: z.number().int(),
  }),
  execute: ({sides}) => Math.floor(Math.random() * sides) + 1,
});

const rollAgent = new LlmAgent({
  name: 'roll_agent',
  model: PARITY_MODEL,
  description: 'Handles rolling dice of different sizes.',
  instruction: `
      You are responsible for rolling dice based on the user's request.
      When asked to roll a die, you must call the roll_die tool with the number of sides as an integer.
    `,
  tools: [rollDie],
  generateContentConfig: {
    safetySettings: [
      {
        // avoid false alarm about rolling dice.
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.OFF,
      },
    ],
  },
});

const checkPrime = new FunctionTool({
  name: 'check_prime',
  description: 'Check if a given list of numbers are prime.',
  parameters: z.object({
    nums: z.array(z.number().int()),
  }),
  execute: ({nums}) => {
    const primes = new Set<number>();
    for (const num of nums) {
      const n = Math.trunc(num);
      if (n <= 1) continue;
      let isPrime = true;
      for (let i = 2; i <= Math.sqrt(n); i++) {
        if (n % i === 0) {
          isPrime = false;
          break;
        }
      }
      if (isPrime) primes.add(n);
    }
    return primes.size === 0
      ? 'No prime numbers found.'
      : `${[...primes].join(', ')} are prime numbers.`;
  },
});

const primeAgent = new LlmAgent({
  name: 'prime_agent',
  model: PARITY_MODEL,
  description: 'Handles checking if numbers are prime.',
  instruction: `
      You are responsible for checking whether numbers are prime.
      When asked to check primes, you must call the check_prime tool with a list of integers.
      Never attempt to determine prime numbers manually.
    `,
  tools: [checkPrime],
  generateContentConfig: {
    safetySettings: [
      {
        // avoid false alarm about rolling dice.
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.OFF,
      },
    ],
  },
});

export const rootAgent = new SequentialAgent({
  name: 'simple_sequential_agent',
  subAgents: [rollAgent, primeAgent],
  // The agents will run in the order provided: roll_agent -> prime_agent
});
