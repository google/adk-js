/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {describe, expect, it, vi} from 'vitest';

import type {
  ChromeCreateOptions,
  ChromeLanguageModelFactory,
  ChromeLanguageModelSession,
  ChromeMessage,
  ChromeModelAvailability,
  ChromePromptOptions,
} from '@google/adk';
import {
  ChromePromptApiLlm,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  stripAdkIdentityPreamble,
} from '@google/adk';

/** A scriptable stand-in for the `LanguageModel` global. */
function fakeLanguageModel(
  reply: string | ((prompt: unknown) => string),
  options: {
    availability?: ChromeModelAvailability;
    createDelayMs?: number;
  } = {},
) {
  const createCalls: unknown[] = [];
  const cloneCalls: unknown[] = [];
  const destroyed: string[] = [];
  const promptCalls: Array<{
    input: string | ChromeMessage[];
    options?: ChromePromptOptions;
  }> = [];

  const makeSession = (kind: string): ChromeLanguageModelSession => ({
    prompt: async (
      input: string | ChromeMessage[],
      options?: ChromePromptOptions,
    ) => {
      promptCalls.push({input, options});
      return typeof reply === 'function' ? reply(input) : reply;
    },
    promptStreaming: () =>
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hel');
          controller.enqueue('lo');
          controller.close();
        },
      }),
    clone: async () => {
      cloneCalls.push(kind);
      return makeSession('clone');
    },
    destroy: () => {
      destroyed.push(kind);
    },
    contextUsage: 10,
    contextWindow: 4096,
  });

  const factory: ChromeLanguageModelFactory = {
    availability: async () => options.availability ?? 'available',
    create: async (createOptions?: ChromeCreateOptions) => {
      createCalls.push(createOptions);
      if (options.createDelayMs) {
        await new Promise((r) => setTimeout(r, options.createDelayMs));
      }
      return makeSession('base');
    },
  };

  return {createCalls, cloneCalls, destroyed, promptCalls, factory};
}

function request(overrides: Record<string, unknown> = {}): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    toolsDict: {},
    ...overrides,
  } as unknown as LlmRequest;
}

const searchTool = {
  functionDeclarations: [
    {
      name: 'searchProducts',
      description: 'Search the catalogue.',
      parameters: {
        type: 'OBJECT',
        properties: {query: {type: 'STRING'}},
        required: ['query'],
      },
    },
  ],
};

async function collect(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const response of generator) out.push(response);
  return out;
}

describe('ChromePromptApiLlm', () => {
  it('is resolvable from the registry by model string', () => {
    expect(LLMRegistry.resolve('chrome-on-device')).toBe(ChromePromptApiLlm);
    expect(LLMRegistry.resolve('chrome/whatever')).toBe(ChromePromptApiLlm);
  });

  it('returns the final text when the model answers directly', async () => {
    const fake = fakeLanguageModel(
      JSON.stringify({kind: 'final', text: 'the answer'}),
    );
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    const responses = await collect(
      llm.generateContentAsync(request({config: {tools: [searchTool]}})),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]!.content?.parts?.[0]?.text).toBe('the answer');
  });

  it('turns a constrained tool reply into a functionCall part', async () => {
    const fake = fakeLanguageModel(
      JSON.stringify({
        kind: 'tool',
        name: 'searchProducts',
        args: {query: 'drill'},
      }),
    );
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    const responses = await collect(
      llm.generateContentAsync(request({config: {tools: [searchTool]}})),
    );

    const call = responses[0]!.content?.parts?.[0]?.functionCall;
    expect(call?.name).toBe('searchProducts');
    expect(call?.args).toEqual({query: 'drill'});
    expect(call?.id).toBeTruthy();
  });

  it('passes the tool-choice schema as a responseConstraint', async () => {
    const fake = fakeLanguageModel(JSON.stringify({kind: 'final', text: 'x'}));
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});
    await collect(
      llm.generateContentAsync(request({config: {tools: [searchTool]}})),
    );

    const options = fake.promptCalls[0]!.options;
    expect(options?.omitResponseConstraintInput).toBe(true);
    const constraint = options?.responseConstraint as
      | {anyOf?: Array<Record<string, unknown>>}
      | undefined;
    expect(constraint?.anyOf).toHaveLength(2);
    // genai's uppercase OBJECT/STRING must be lowercased for JSON Schema.
    expect(JSON.stringify(constraint)).toContain('"type":"string"');
    expect(JSON.stringify(constraint)).not.toContain('STRING');
  });

  it('refuses a tool the request never declared', async () => {
    const fake = fakeLanguageModel(
      JSON.stringify({kind: 'tool', name: 'deleteEverything', args: {}}),
    );
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    const responses = await collect(
      llm.generateContentAsync(request({config: {tools: [searchTool]}})),
    );

    expect(responses[0]!.content?.parts?.[0]?.functionCall).toBeUndefined();
    expect(responses[0]!.content?.parts?.[0]?.text).toContain(
      'deleteEverything',
    );
  });

  it('salvages JSON that the model wrapped in prose', async () => {
    const fake = fakeLanguageModel(
      'Sure! ```json\n{"kind":"final","text":"salvaged"}\n```',
    );
    const diagnostics: string[] = [];
    const llm = new ChromePromptApiLlm({
      languageModel: fake.factory,
      onDiagnostic: (d) => diagnostics.push(d.phase),
    });

    const responses = await collect(
      llm.generateContentAsync(request({config: {tools: [searchTool]}})),
    );

    expect(responses[0]!.content?.parts?.[0]?.text).toBe('salvaged');
  });

  it('creates the base session once across a concurrent fan-out', async () => {
    // The ParallelAgent case: N children hit the adapter at the same instant.
    // Memoising the resolved session instead of the promise would produce N
    // creates, which is the most expensive call available.
    const fake = fakeLanguageModel(
      JSON.stringify({kind: 'final', text: 'ok'}),
      {createDelayMs: 20},
    );
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    await Promise.all(
      Array.from({length: 8}, () =>
        collect(llm.generateContentAsync(request())),
      ),
    );

    expect(fake.createCalls).toHaveLength(1);
    expect(fake.cloneCalls).toHaveLength(8);
  });

  it('rebuilds the base session when the system prompt changes', async () => {
    const fake = fakeLanguageModel(JSON.stringify({kind: 'final', text: 'ok'}));
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    await collect(
      llm.generateContentAsync(request({config: {systemInstruction: 'one'}})),
    );
    await collect(
      llm.generateContentAsync(request({config: {systemInstruction: 'two'}})),
    );

    expect(fake.createCalls).toHaveLength(2);
  });

  it('destroys clones but keeps the base session warm', async () => {
    const fake = fakeLanguageModel(JSON.stringify({kind: 'final', text: 'ok'}));
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    await collect(llm.generateContentAsync(request()));

    expect(fake.destroyed).toEqual(['clone']);
  });

  it('retries without sampling parameters when create rejects them', async () => {
    // temperature/topK are extension-only; a plain web page rejects them.
    const fake = fakeLanguageModel('ok');
    const original = fake.factory.create;
    let firstCall = true;
    fake.factory.create = async (options?: ChromeCreateOptions) => {
      if (firstCall) {
        firstCall = false;
        throw new TypeError('temperature is not supported');
      }
      return original(options);
    };

    const llm = new ChromePromptApiLlm({
      languageModel: fake.factory,
      temperature: 0.2,
    });
    const responses = await collect(llm.generateContentAsync(request()));

    expect(responses[0]!.content?.parts?.[0]?.text).toBe('ok');
  });

  it('reports an error response when the model is unavailable', async () => {
    const fake = fakeLanguageModel('', {availability: 'unavailable'});
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    const responses = await collect(llm.generateContentAsync(request()));

    expect(responses[0]!.errorCode).toBe('ChromeModelUnavailableError');
    expect(responses[0]!.errorMessage).toContain('not available');
  });

  it('streams free text but not schema-constrained output', async () => {
    const fake = fakeLanguageModel(JSON.stringify({kind: 'final', text: 'x'}));
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    const streamed = await collect(llm.generateContentAsync(request(), true));
    expect(streamed.filter((r) => r.partial)).toHaveLength(2);
    expect(streamed.at(-1)?.content?.parts?.[0]?.text).toBe('hello');

    // With tools in play the reply must satisfy a schema, so it cannot stream.
    const constrained = await collect(
      llm.generateContentAsync(request({config: {tools: [searchTool]}}), true),
    );
    expect(constrained.some((r) => r.partial)).toBe(false);
  });

  it('rejects connect(), which the Prompt API cannot support', async () => {
    const llm = new ChromePromptApiLlm({
      languageModel: fakeLanguageModel('').factory,
    });
    await expect(llm.connect(request())).rejects.toThrow(
      /no bidirectional live mode/,
    );
  });

  it('serialises tool calls and results into the prompt', async () => {
    const seen = vi.fn();
    const fake = fakeLanguageModel((input) => {
      seen(input);
      return JSON.stringify({kind: 'final', text: 'ok'});
    });
    const llm = new ChromePromptApiLlm({languageModel: fake.factory});

    await collect(
      llm.generateContentAsync(
        request({
          contents: [
            {role: 'user', parts: [{text: 'find a drill'}]},
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'searchProducts',
                    args: {query: 'drill'},
                  },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'searchProducts',
                    // ADK's {result: "<json string>"} envelope. Re-encoding it
                    // naively doubles every quote and small models choke.
                    response: {result: '{"matches":[{"id":8}]}'},
                  },
                },
              ],
            },
          ],
        }),
      ),
    );

    const messages = seen.mock.calls[0]![0] as Array<{content: string}>;
    const text = messages.map((m) => m.content).join('\n');
    expect(text).toContain('[tool_call] searchProducts({"query":"drill"})');
    expect(text).toContain('[tool_result] searchProducts -> {"matches"');
    expect(text).not.toContain('\\"matches\\"');
  });
});

describe('stripAdkIdentityPreamble', () => {
  it('removes the identity lines so siblings share one session', () => {
    const prompt = [
      'You are an agent. Your internal name is "rerank_11".',
      'The description about you is "scores one candidate"',
      '',
      'Score the page from 0 to 3.',
    ].join('\n');

    expect(stripAdkIdentityPreamble(prompt)).toBe(
      'Score the page from 0 to 3.',
    );
  });

  it('leaves a prompt without the preamble untouched', () => {
    expect(stripAdkIdentityPreamble('Just do the thing.')).toBe(
      'Just do the thing.',
    );
  });
});
