/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  InMemoryRunner,
  LlmAgent,
  LlmResponse,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

class ThinkingLlm extends BaseLlm {
  constructor(private readonly answer: string) {
    super({model: 'thinking-llm'});
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    yield {
      content: {
        role: 'model',
        parts: [
          {text: 'Let me think about this. ', thought: true},
          {text: this.answer},
        ],
      },
    };
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error('not implemented');
  }
}

async function runAndReadOut(agent: LlmAgent): Promise<unknown> {
  const runner = new InMemoryRunner({agent, appName: 'app'});
  const session = await runner.sessionService.createSession({
    appName: 'app',
    userId: 'u',
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

describe('LlmAgent outputKey with thought parts', () => {
  it('stores only the answer text, not the thoughts', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: new ThinkingLlm('The answer is 42.'),
      outputKey: 'out',
    });
    expect(await runAndReadOut(agent)).toBe('The answer is 42.');
  });

  it('parses the answer against outputSchema without the thoughts', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: new ThinkingLlm('{"answer": 42}'),
      outputKey: 'out',
      outputSchema: z.object({answer: z.number()}),
    });
    expect(await runAndReadOut(agent)).toEqual({answer: 42});
  });
});
