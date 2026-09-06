/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/context_management/history_management.
 *
 * Ported as literally as the two APIs allow: same tool names, same parameter
 * names, same instruction text, same window size. Divergence in the transcript
 * should come from the runtimes, not from the agent definition.
 *
 * The sample trims the context window by hand in a `before_model_callback`
 * rather than by any framework feature, and `llmRequest.contents` is mutable
 * in both runtimes, so this is a direct translation. (adk-js additionally has
 * `LlmAgent.contextCompactors`, which the Python sample has no counterpart
 * for; it is deliberately not used here.)
 */
import type {SingleBeforeModelCallback} from '@google/adk';
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Roll a die and return the rolled result.',
  parameters: z.object({
    sides: z
      .number()
      .int()
      .describe('The integer number of sides the die has.'),
  }),
  execute: ({sides}, toolContext) => {
    const result = Math.floor(Math.random() * sides) + 1;
    // Python indexes state as a dict (`tool_context.state['rolls']`); TS
    // exposes get/set. Same semantics, different surface.
    const rolls =
      (toolContext?.state.get('rolls') as number[] | undefined) ?? [];
    toolContext?.state.set('rolls', [...rolls, result]);
    return result;
  },
});

const checkPrime = new FunctionTool({
  name: 'check_prime',
  description: 'Check if a given list of numbers are prime.',
  parameters: z.object({
    nums: z.array(z.number().int()).describe('The list of numbers to check.'),
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

/**
 * Keeps only the last `nRecentTurns` user turns in the model request.
 *
 * Same algorithm as the Python sample: find the indexes of the user contents,
 * take the one `nRecentTurns` from the end, and drop everything before it.
 */
function createSliceHistoryCallback(
  nRecentTurns: number,
): SingleBeforeModelCallback {
  return ({request}) => {
    if (nRecentTurns < 1) {
      return undefined;
    }

    const userIndexes: number[] = [];
    request.contents.forEach((content, i) => {
      if (content.role === 'user') {
        userIndexes.push(i);
      }
    });

    if (nRecentTurns > userIndexes.length) {
      return undefined;
    }

    const suffixIdx = userIndexes[userIndexes.length - nRecentTurns];
    request.contents = request.contents.slice(suffixIdx);
    return undefined;
  };
}

export const rootAgent = new LlmAgent({
  name: 'short_history_agent',
  model: PARITY_MODEL,
  description:
    'an agent that maintains only the last turn in its context window.' +
    ' numbers.',
  instruction: `
      You roll dice and answer questions about the outcome of the dice rolls.
      You can roll dice of different sizes.
      You can use multiple tools in parallel by calling functions in parallel(in one request and in one round).
      It is ok to discuss previous dice roles, and comment on the dice rolls.
      When you are asked to roll a die, you must call the roll_die tool with the number of sides. Be sure to pass in an integer. Do not pass in a string.
      You should never roll a die on your own.
      When checking prime numbers, call the check_prime tool with a list of integers. Be sure to pass in a list of integers. You should never pass in a string.
      You should not check prime numbers before calling the tool.
      When you are asked to roll a die and check prime numbers, you should always make the following two function calls:
      1. You should first call the roll_die tool to get a roll. Wait for the function response before calling the check_prime tool.
      2. After you get the function response from roll_die tool, you should call the check_prime tool with the roll_die result.
        2.1 If user asks you to check primes based on previous rolls, make sure you include the previous rolls in the list.
      3. When you respond, you must include the roll_die result from step 1.
      You should always perform the previous 3 steps when asking for a roll and checking prime numbers.
      You should not rely on the previous history on prime results.
    `,
  tools: [rollDie, checkPrime],
  beforeModelCallback: createSliceHistoryCallback(2),
});
