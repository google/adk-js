/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Planners (`BasePlanner`, `BuiltInPlanner`, and `PlanReActPlanner`)
 * ../../docs/guides/planners/index.md
 *
 * A dice-and-primes `LlmAgent` with a `planner`. The agent rolls dice with
 * `roll_die` and checks the results with `check_prime`, and the planner makes
 * it plan before it acts.
 *
 * `BuiltInPlanner` runs by default. It sets `thinkingConfig` with
 * `includeThoughts: true`, so the model returns its own thoughts as parts with
 * `thought: true`. Set ADK_SAMPLE_PLANNER=plan_react to use `PlanReActPlanner`
 * instead: it adds a planning instruction to the request and marks the tagged
 * planning and reasoning text in the response as thoughts. Any other value of
 * ADK_SAMPLE_PLANNER is an error.
 *
 * This sample exports `rootAgent` for `adk web` and `npm run sample`, and also
 * includes a direct `InMemoryRunner` driver (`main()`) because the CLI joins
 * the text of every part, thoughts included — running directly lets `main()`
 * print thought parts, function calls and the answer separately.
 *
 * REQUIRES an API key (the agent calls a live model). Set GEMINI_API_KEY, then:
 *   npx tsx samples/planners/agent.ts
 *   npm run sample -- samples/planners/agent.ts
 *   ADK_SAMPLE_PLANNER=plan_react npm run sample -- samples/planners/agent.ts
 * Try "Roll a 20-sided die and check if the result is prime.".
 */

import {
  BasePlanner,
  BuiltInPlanner,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  PlanReActPlanner,
} from '@google/adk';
import {HarmBlockThreshold, HarmCategory} from '@google/genai';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Roll a die and return the rolled result.',
  parameters: z.object({
    sides: z
      .number()
      .int()
      .describe('The integer number of sides the die has.'),
  }),
  execute: ({sides}) => Math.floor(Math.random() * sides) + 1,
});

function isPrime(n: number): boolean {
  if (n <= 1) {
    return false;
  }
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) {
      return false;
    }
  }
  return true;
}

const checkPrime = new FunctionTool({
  name: 'check_prime',
  description: 'Check if a given list of numbers are prime.',
  parameters: z.object({
    nums: z.array(z.number().int()).describe('The list of numbers to check.'),
  }),
  execute: ({nums}) => {
    const primes = [...new Set(nums.map(Math.trunc))].filter(isPrime);
    return primes.length === 0
      ? 'No prime numbers found.'
      : `${primes.join(', ')} are prime numbers.`;
  },
});

function createPlanner(): BasePlanner {
  const choice = process.env['ADK_SAMPLE_PLANNER'] ?? 'built_in';
  switch (choice) {
    case 'built_in':
      return new BuiltInPlanner({thinkingConfig: {includeThoughts: true}});
    case 'plan_react':
      return new PlanReActPlanner();
    default:
      throw new Error(
        `Unknown ADK_SAMPLE_PLANNER "${choice}". Use "built_in" (the default) or "plan_react".`,
      );
  }
}

export const rootAgent = new LlmAgent({
  model: 'gemini-flash-latest',
  name: 'data_processing_agent',
  instruction: `
      You roll dice and answer questions about the outcome of the dice rolls.
      You can roll dice of different sizes.
      You can use multiple tools in parallel by calling functions in parallel(in one request and in one round).
      The only things you do are roll dice for the user and discuss the outcomes.
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
  planner: createPlanner(),
  generateContentConfig: {
    safetySettings: [
      {
        // Avoids a false alarm about rolling dice.
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.OFF,
      },
    ],
  },
});

async function main() {
  const appName = 'planners_sample_app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({agent: rootAgent, appName});
  const session = await runner.sessionService.createSession({appName, userId});

  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [{text: 'Roll a 20-sided die and check if the result is prime.'}],
    },
  })) {
    for (const part of event.content?.parts ?? []) {
      if (part.thought && part.text) {
        process.stdout.write(`[${event.author}] thought: ${part.text}\n`);
      } else if (part.functionCall) {
        process.stdout.write(
          `[${event.author}] call: ${part.functionCall.name} ${JSON.stringify(part.functionCall.args)}\n`,
        );
      } else if (part.functionResponse) {
        process.stdout.write(
          `[${event.author}] result: ${part.functionResponse.name} ${JSON.stringify(part.functionResponse.response)}\n`,
        );
      } else if (part.text) {
        process.stdout.write(`[${event.author}] answer: ${part.text}\n`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
