/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives Claude through a real `InMemoryRunner` against the live Anthropic API.
 *
 * Skipped unless ANTHROPIC_API_KEY is set, so it is a no-op in CI and on a
 * clone with no Anthropic account. The unit suite in
 * `integrations/test/models/` covers the conversions offline; what only a live
 * call can prove is that the request this builds is one Anthropic accepts —
 * the tool input schema in particular, which Anthropic validates strictly.
 */

import {
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  StreamingMode,
} from '@google/adk';
import {AnthropicLlm} from '@google/adk-integrations';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const envPath of [
  path.resolve(here, '../.env'),
  path.resolve(here, '../../../.env'),
]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
    break;
  }
}

const MODEL = 'claude-sonnet-4-5-20250929';
const hasKey = !!process.env.ANTHROPIC_API_KEY;

/** Runs one turn and returns the text the agent produced. */
async function ask(
  agent: LlmAgent,
  appName: string,
  message: string,
  streaming = false,
): Promise<string> {
  const runner = new InMemoryRunner({agent, appName});
  const session = await runner.sessionService.createSession({
    appName,
    userId: 'e2e_user',
  });

  let text = '';
  for await (const event of runner.runAsync({
    userId: 'e2e_user',
    sessionId: session.id,
    newMessage: createUserContent(message),
    ...(streaming ? {runConfig: {streamingMode: StreamingMode.SSE}} : {}),
  })) {
    if (event.author !== agent.name || event.partial) {
      continue;
    }
    for (const part of event.content?.parts ?? []) {
      if (part.text && !part.thought) {
        text += part.text;
      }
    }
  }
  return text;
}

describe.skipIf(!hasKey)('Claude E2E', () => {
  it('answers a plain question', async () => {
    const agent = new LlmAgent({
      name: 'claude_text_agent',
      model: MODEL,
      instruction: 'Answer with the bare number and nothing else.',
    });

    const answer = await ask(agent, 'e2e_claude_text', 'What is 2 + 3?');

    expect(answer).toContain('5');
  }, 60000);

  it('calls a tool and answers from its result', async () => {
    const getWeather = new FunctionTool({
      name: 'get_weather',
      description: 'Look up the current weather in a city.',
      parameters: z.object({
        city: z.string().describe('The city to look up.'),
      }),
      execute: async ({city}: {city: string}) => ({
        city,
        degrees: 22,
        sky: 'sunny',
      }),
    });

    const agent = new LlmAgent({
      name: 'claude_tool_agent',
      model: new AnthropicLlm({model: MODEL}),
      instruction:
        'Use get_weather to answer weather questions, then reply in one ' +
        'short sentence.',
      tools: [getWeather],
    });

    const answer = await ask(
      agent,
      'e2e_claude_tools',
      "What's the weather in Oslo?",
    );

    expect(answer.toLowerCase()).toMatch(/sunny|22/);
  }, 60000);

  it('streams a response', async () => {
    const agent = new LlmAgent({
      name: 'claude_stream_agent',
      model: new AnthropicLlm({model: MODEL}),
      instruction: 'Answer in one short sentence.',
    });

    const answer = await ask(
      agent,
      'e2e_claude_streaming',
      'Name one primary colour.',
      true,
    );

    expect(answer.length).toBeGreaterThan(0);
  }, 60000);
});
