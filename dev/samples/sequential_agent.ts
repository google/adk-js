/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {FunctionTool, LlmAgent, SequentialAgent} from '@google/adk';
import {z} from 'zod';

function getRandomIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const rollDiceTool = new FunctionTool({
  name: 'roll_dice',
  description: 'Roll a die and return the rolled result.',
  parameters: z.object({
    sides: z.number().describe('The number of sides of the dice.'),
  }),
  execute: ({sides}: {sides: number}) => {
    return getRandomIntInclusive(1, sides);
  },
});

const rollAgent = new LlmAgent({
  name: 'roll_agent',
  description: 'Handles rolling dice of different sizes.',
  model: 'gemini-2.5-flash',
  instruction: `You are responsible for rolling dice based on the user's request. When asked to roll a dice, you must call the roll_dice tool with the number of sides as an integer.`,
  tools: [rollDiceTool],
});

const checkPrimeTool = new FunctionTool({
  name: 'check_prime',
  description: 'Check if a given list of numbers are prime.',
  parameters: z.object({
    numbers: z.array(z.number()).describe('The list of numbers to check.'),
  }),
  execute: ({numbers}: {numbers: number[]}) => {
    const primes = new Set<number>();

    for (const number of numbers) {
      if (number <= 1) {
        continue;
      }

      if (number === 2) {
        primes.add(number);
        continue;
      }

      let isPrime = true;
      for (let i = 2; i <= Math.floor(number ** 0.5) + 1; i++) {
        if (number % i === 0) {
          isPrime = false;
          break;
        }
      }
      if (isPrime) {
        primes.add(number);
      }
    }
    if (primes.size === 0) {
      return 'No prime numbers found.';
    }
    return `${[...primes].join(', ')} are prime numbers.`;
  },
});

const primeAgent = new LlmAgent({
  name: 'prime_agent',
  description: 'Handles checking if numbers are prime.',
  model: 'gemini-2.5-flash',
  instruction: `You are responsible for checking whether numbers are prime. When asked to check primes, you must call the check_prime tool with a list of integers. Never attempt to determine prime numbers manually. Return the prime number results to the root agent.`,
  tools: [checkPrimeTool],
});

export const rootAgent = new SequentialAgent({
  name: 'simple_sequential_agent',
  subAgents: [rollAgent, primeAgent],
});
