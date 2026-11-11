/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmResponse,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

class FixedPartsLlm extends BaseLlm {
  calls = 0;
  constructor(private readonly parts: Part[]) {
    super({model: 'fixed-parts-llm'});
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    this.calls++;
    yield {content: {role: 'model', parts: this.parts}};
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error('not implemented');
  }
}

async function runAndReadOut(
  agent: LlmAgent,
  initialState?: Record<string, unknown>,
): Promise<unknown> {
  const runner = new InMemoryRunner({agent, appName: 'app'});
  const session = await runner.sessionService.createSession({
    appName: 'app',
    userId: 'u',
    state: initialState,
  });
  for await (const _event of runner.runAsync({
    userId: 'u',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'hi'}]},
  })) {
    // drain
  }
  const stored = await runner.sessionService.getSession({
    appName: 'app',
    userId: 'u',
    sessionId: session.id,
  });
  return stored!.state['out'];
}

describe('LlmAgent outputKey on a final event without text', () => {
  it('keeps the value a skipSummarization tool wrote to outputKey', async () => {
    const lookup = new FunctionTool({
      name: 'lookup',
      description: 'Looks the value up.',
      parameters: z.object({}),
      execute: (_args, context) => {
        context!.state.set('out', 'value from tool');
        context!.actions.skipSummarization = true;
        return {ok: true};
      },
    });
    const llm = new FixedPartsLlm([{functionCall: {name: 'lookup', args: {}}}]);
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      tools: [lookup],
      outputKey: 'out',
    });
    expect(await runAndReadOut(agent)).toBe('value from tool');
    expect(llm.calls).toBe(1);
  });

  it('leaves outputKey alone when the final event has only thoughts', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: new FixedPartsLlm([{text: 'Thinking...', thought: true}]),
      outputKey: 'out',
    });
    expect(await runAndReadOut(agent, {out: 'previous'})).toBe('previous');
  });
});
