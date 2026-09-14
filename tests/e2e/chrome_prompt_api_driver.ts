/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The page-side driver for `chrome_prompt_api_test.ts`.
 *
 * These functions run inside the browser page, not in Node. The test bundles
 * this module with esbuild and injects the bundle into the page with Playwright,
 * then calls the exports through `page.evaluate`. Each function returns a plain
 * object so its result survives the serialisation boundary Playwright crosses.
 *
 * The relative imports reach into `core/src` directly. esbuild follows them and
 * bundles only that subgraph, which keeps the browser bundle small; importing
 * the `@google/adk` barrel would pull in Node-only modules the page cannot load.
 */

import type {Part} from '@google/genai';
import {z} from 'zod';

import {LlmAgent} from '../../core/src/agents/llm_agent.js';
import type {Event} from '../../core/src/events/event.js';
import {
  ChromeBuiltInLlm,
  type ChromeLanguageModelFactory,
} from '../../core/src/models/chrome_prompt_llm.js';
import {InMemoryRunner} from '../../core/src/runner/in_memory_runner.js';
import {FunctionTool} from '../../core/src/tools/function_tool.js';

const textOf = (event: Event): string =>
  (event.content?.parts ?? []).map((p) => p.text ?? '').join('');

const anyPart = (
  events: Event[],
  predicate: (part: Part) => boolean,
): boolean =>
  events.some((event) => (event.content?.parts ?? []).some(predicate));

/** Runs one user turn through the ADK runner and collects its events. */
async function runTurn(agent: LlmAgent, question: string): Promise<Event[]> {
  const runner = new InMemoryRunner({agent});
  const events: Event[] = [];
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

export async function availability(): Promise<string> {
  const languageModel = (
    globalThis as {LanguageModel?: ChromeLanguageModelFactory}
  ).LanguageModel;
  if (!languageModel) return 'missing-api';
  return languageModel.availability();
}

/** The agent answers a plain question, with no tools. */
export async function answer(
  question: string,
): Promise<{events: number; text: string; error: string | null}> {
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
export async function toolCall(question: string): Promise<{
  toolRuns: number;
  toolCity: string | null;
  calledTool: boolean;
  gotToolResponse: boolean;
}> {
  let toolRuns = 0;
  let toolCity: string | null = null;
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
