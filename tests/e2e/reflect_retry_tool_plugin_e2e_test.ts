/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmResponse,
  REFLECT_AND_RETRY_RESPONSE_TYPE,
  ReflectAndRetryToolPlugin,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

// --------------------------------------------------------------------------
// End-to-end: drive a real InMemoryRunner with a scripted (non-mock) model.
//
// A real FunctionTool throws on its first call and succeeds on the second. The
// plugin must convert the first failure into a reflection guidance payload fed
// back to the model, then let the retry succeed. No plugin internals are
// stubbed -- only the LLM is scripted (deterministic), exactly as the real
// PluginManager + tool-execution flow drive it.
// --------------------------------------------------------------------------

/** A deterministic model that yields a pre-scripted response per turn. */
class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-test-llm'});
  }

  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    const next =
      this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index++;
    yield next;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not supported by ScriptedLlm');
  }
}

function functionCallResponse(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {
    content: {role: 'model', parts: [{functionCall: {id, name, args}}]},
  };
}

function collectResponses(events: Event[]): Array<Record<string, unknown>> {
  return events
    .flatMap((event) => event.content?.parts ?? [])
    .map((part) => part.functionResponse?.response)
    .filter((response): response is Record<string, unknown> => !!response);
}

describe('ReflectAndRetryToolPlugin (end-to-end)', () => {
  it('recovers a failing tool by feeding reflection guidance to the model', async () => {
    let callCount = 0;
    const flaky = new FunctionTool({
      name: 'flaky',
      description: 'Fails on the first call, then succeeds.',
      parameters: z.object({x: z.number()}),
      execute: async ({x}) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('transient failure');
        }
        return {value: x + 1};
      },
    });

    const model = new ScriptedLlm([
      functionCallResponse('call-1', 'flaky', {x: 1}),
      functionCallResponse('call-2', 'flaky', {x: 1}),
      {content: {role: 'model', parts: [{text: 'All done.'}]}},
    ]);

    const agent = new LlmAgent({
      name: 'root_agent',
      description: 'Agent under test.',
      model,
      tools: [flaky],
    });
    const plugin = new ReflectAndRetryToolPlugin();
    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user-1',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'please run flaky'}]},
    })) {
      events.push(event);
    }

    const responses = collectResponses(events);

    const reflections = responses.filter(
      (r) => r['response_type'] === REFLECT_AND_RETRY_RESPONSE_TYPE,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0]['error_type']).toBe('Error');
    expect(reflections[0]['retry_count']).toBe(1);
    expect(String(reflections[0]['reflection_guidance'])).toContain(
      'Wrong Function Name',
    );

    // The retry actually executed and returned the corrected result.
    expect(callCount).toBe(2);
    const successes = responses.filter((r) => r['value'] === 2);
    expect(successes).toHaveLength(1);

    // The run recovered and produced the final text response.
    const finalText = events
      .flatMap((event) => event.content?.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => !!text);
    expect(finalText).toContain('All done.');
  });
});
