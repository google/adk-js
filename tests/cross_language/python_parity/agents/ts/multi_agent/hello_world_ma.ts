/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/multi_agent/hello_world_ma.
 *
 * A root agent that owns two sub-agents and routes to them by description, so
 * the agent names, descriptions and instruction text are reproduced verbatim:
 * the model's transfer decision is made from exactly those strings.
 */
import {ExampleTool, FunctionTool, LlmAgent} from '@google/adk';
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
  execute: ({sides}) => {
    // The Python sample pins the roll under pytest; kept so the two ports
    // behave identically in every environment.
    if (process.env['PYTEST_CURRENT_TEST']) {
      return 2;
    }
    return Math.floor(Math.random() * sides) + 1;
  },
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

// --- Prime Check Sub-Agent ---
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

// `types.UserContent`/`types.ModelContent` are Python-only conveniences that
// only set `role`; TS spells the role out.
const exampleTool = new ExampleTool([
  {
    input: {role: 'user', parts: [{text: 'Roll a 6-sided die.'}]},
    output: [{role: 'model', parts: [{text: 'I rolled a 4 for you.'}]}],
  },
  {
    input: {role: 'user', parts: [{text: 'Is 7 a prime number?'}]},
    output: [{role: 'model', parts: [{text: 'Yes, 7 is a prime number.'}]}],
  },
  {
    input: {
      role: 'user',
      parts: [{text: "Roll a 10-sided die and check if it's prime."}],
    },
    output: [
      {role: 'model', parts: [{text: 'I rolled an 8 for you.'}]},
      {role: 'model', parts: [{text: '8 is not a prime number.'}]},
    ],
  },
]);

const primeAgent = new LlmAgent({
  name: 'prime_agent',
  model: PARITY_MODEL,
  description: 'Handles checking if numbers are prime.',
  instruction: `
      You are responsible for checking whether numbers are prime.
      When asked to check primes, you must call the check_prime tool with a list of integers.
      Never attempt to determine prime numbers manually.
      Return the prime number results to the root agent.
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

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: PARITY_MODEL,
  instruction: `
      You are a helpful assistant that can roll dice and check if numbers are prime.
      You delegate rolling dice tasks to the roll_agent and prime checking tasks to the prime_agent.
      Follow these steps:
      1. If the user asks to roll a die, delegate to the roll_agent.
      2. If the user asks to check primes, delegate to the prime_agent.
      3. If the user asks to roll a die and then check if the result is prime, call roll_agent first, then pass the result to prime_agent.
      Always clarify the results before proceeding.
    `,
  globalInstruction:
    'You are DicePrimeBot, ready to roll dice and check prime numbers.',
  subAgents: [rollAgent, primeAgent],
  tools: [exampleTool],
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
