/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The page-side driver for `chrome_prompt_api_test.ts`.
 *
 * Runs in the page and returns plain objects so its results survive the CDP
 * boundary. Kept as a string rather than a real module so esbuild bundles it
 * with the adapter in one pass and nothing has to be served over http. The
 * relative imports resolve against `core/src/models`, which the test passes to
 * esbuild as the `resolveDir`.
 */
export const DRIVER_SOURCE = `
import {z} from 'zod';

import {LlmAgent} from '../agents/llm_agent.js';
import {FunctionTool} from '../tools/function_tool.js';
import {InMemoryRunner} from '../runner/in_memory_runner.js';

import {ChromeBuiltInLlm} from './chrome_prompt_llm.js';

const textOf = (event) =>
  (event?.content?.parts ?? []).map((p) => p.text ?? '').join('');

const anyPart = (events, predicate) =>
  events.some((event) => (event.content?.parts ?? []).some(predicate));

/** Runs one user turn through the ADK runner and collects its events. */
async function runTurn(agent, question) {
  const runner = new InMemoryRunner({agent});
  const events = [];
  for await (const event of runner.runEphemeral({
    userId: 'e2e',
    newMessage: {role: 'user', parts: [{text: question}]},
    // Bound the loop so a small model that keeps re-calling a tool cannot
    // spin forever.
    runConfig: {maxLlmCalls: 6},
  })) {
    events.push(event);
  }
  return events;
}

export async function availability() {
  if (typeof globalThis.LanguageModel === 'undefined') return 'missing-api';
  return await globalThis.LanguageModel.availability();
}

/** The agent answers a plain question, with no tools. */
export async function answer(question) {
  const agent = new LlmAgent({
    name: 'answerer',
    model: new ChromeBuiltInLlm(),
    instruction: 'Answer in one short sentence.',
  });
  const events = await runTurn(agent, question);
  const error =
    events.map((e) => e.errorCode ?? null).find((code) => code) ?? null;
  const text = events
    .filter((e) => !e.partial)
    .map(textOf)
    .join('');
  return {events: events.length, text, error};
}

/** The agent runs a declared tool through the full ADK loop. */
export async function toolCall(question) {
  let toolRuns = 0;
  let toolCity = null;
  const getWeather = new FunctionTool({
    name: 'get_weather',
    description: 'Returns the current weather for a city.',
    parameters: z.object({city: z.string()}),
    execute: ({city}) => {
      toolRuns++;
      toolCity = city;
      return {city, forecast: 'sunny, 21C'};
    },
  });
  const agent = new LlmAgent({
    name: 'weatherbot',
    model: new ChromeBuiltInLlm(),
    instruction:
      'You look up weather. Call get_weather for any question about weather.',
    tools: [getWeather],
  });
  const events = await runTurn(agent, question);
  return {
    toolRuns,
    toolCity,
    calledTool: anyPart(events, (p) => p.functionCall?.name === 'get_weather'),
    gotToolResponse: anyPart(
      events,
      (p) => p.functionResponse?.name === 'get_weather',
    ),
  };
}
`;
