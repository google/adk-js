/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FinishReason, GenerateContentConfig, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  BaseLlm,
  BaseLlmConnection,
  ChoiceAnswer,
  createBinary,
  createBinaryAnswer,
  createChoice,
  createChoiceAnswer,
  createScore,
  getClientLabels,
  isLlmClassifier,
  LlmClassifier,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  runWithClientLabel,
  ScoreAnswer,
} from '../../src/index.js';
import {classifierClientLabel} from '../../src/utils/client_labels.js';

interface FakeLlmOptions {
  readonly model?: string;
  readonly reply?: string | Record<string, unknown>;
  readonly errorCode?: string;
  readonly modelVersion?: string;
  readonly finishReason?: FinishReason;
  readonly emitPartialFirst?: boolean;
}

class FakeLlm extends BaseLlm {
  readonly reply: string;
  readonly errorCode?: string;
  readonly modelVersion?: string;
  readonly finishReason?: FinishReason;
  readonly emitPartialFirst: boolean;
  readonly requests: LlmRequest[] = [];
  readonly clientLabels: string[][] = [];
  readonly abortSignals: Array<AbortSignal | undefined> = [];

  constructor(options: FakeLlmOptions = {}) {
    super({model: options.model ?? 'fake-llm'});
    this.reply =
      typeof options.reply === 'string'
        ? options.reply
        : JSON.stringify(options.reply ?? {});
    this.errorCode = options.errorCode;
    this.modelVersion = options.modelVersion;
    this.finishReason = options.finishReason;
    this.emitPartialFirst = options.emitPartialFirst ?? false;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    this.clientLabels.push(getClientLabels());
    this.abortSignals.push(abortSignal);
    if (this.emitPartialFirst) {
      yield {
        partial: true,
        content: {
          role: 'model',
          parts: [{text: '{"ignored": true}'}],
        },
      };
    }
    if (this.errorCode) {
      yield {
        errorCode: this.errorCode,
        errorMessage: 'sensitive upstream error detail',
        finishReason: this.finishReason,
      };
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{text: 'thinking...', thought: true}, {text: this.reply}],
      },
      modelVersion: this.modelVersion,
      finishReason: this.finishReason,
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('FakeLlm does not support live connections.');
  }
}

const ROUTE_QUESTION = createChoice({
  instructions: 'Which department handles this?',
  criteria: {billing: 'Invoices and refunds', technical: null},
});

function buildClassifier(
  reply: Record<string, unknown> | string,
  options: Omit<FakeLlmOptions, 'reply'> = {},
): {classifier: LlmClassifier; llm: FakeLlm} {
  const llm = new FakeLlm({...options, reply});
  return {classifier: new LlmClassifier({model: llm}), llm};
}

describe('LlmClassifier', () => {
  it('picks the most likely label for a Choice question', async () => {
    const {classifier} = buildClassifier({
      route: {billing: 0.8, technical: 0.2},
    });
    expect(isLlmClassifier(classifier)).toBe(true);

    const response = await classifier.classify({
      input: 'I was charged twice.',
      questions: {route: ROUTE_QUESTION},
    });

    expect(response.answers['route']).toEqual(
      createChoiceAnswer({
        choice: 'billing',
        probabilities: {billing: 0.8, technical: 0.2},
      }),
    );
  });

  it('normalizes Choice probabilities and clamps negative values to zero without overflowing on large weights', async () => {
    const {classifier} = buildClassifier({
      route: {billing: 3, technical: 1},
    });

    const response = await classifier.classify({
      input: 'x',
      questions: {route: ROUTE_QUESTION},
    });
    const answer = response.answers['route'] as ChoiceAnswer;
    expect(answer.probabilities).toEqual({
      billing: 0.75,
      technical: 0.25,
    });

    const {classifier: hugeClassifier} = buildClassifier({
      route: {billing: 1e308, technical: 1e308},
    });
    const hugeResponse = await hugeClassifier.classify({
      input: 'x',
      questions: {route: ROUTE_QUESTION},
    });
    const hugeAnswer = hugeResponse.answers['route'] as ChoiceAnswer;
    expect(hugeAnswer.probabilities).toEqual({
      billing: 0.5,
      technical: 0.5,
    });
  });

  it('returns the probability of true for a Binary question', async () => {
    const {classifier} = buildClassifier({risky: {probability: 0.3}});

    const response = await classifier.classify({
      input: {tool: 'delete_account'},
      questions: {risky: createBinary({instructions: 'Is this destructive?'})},
    });

    expect(response.answers['risky']).toEqual(
      createBinaryAnswer({probability: 0.3}),
    );
  });

  it('returns the probability-weighted expected level for a Score question', async () => {
    const {classifier} = buildClassifier({
      urgency: {'0': 0.2, '1': 0.3, '2': 0.5},
    });

    const response = await classifier.classify({
      input: 'Site is down.',
      questions: {urgency: createScore({criteria: ['low', 'medium', 'high']})},
    });

    const answer = response.answers['urgency'] as ScoreAnswer;
    expect(answer.type).toBe('score');
    expect(answer.score).toBeCloseTo(1.3);
    expect(answer.probabilities).toEqual({0: 0.2, 1: 0.3, 2: 0.5});
  });

  it('answers multiple questions in a single model call and skips partial chunks', async () => {
    const {classifier, llm} = buildClassifier(
      {
        route: {billing: 0.9, technical: 0.1},
        escalate: {probability: 0.7},
      },
      {emitPartialFirst: true, modelVersion: 'fake-llm-001'},
    );

    const response = await classifier.classify({
      input: 'x',
      questions: {route: ROUTE_QUESTION, escalate: createBinary()},
    });

    expect(Object.keys(response.answers)).toEqual(['route', 'escalate']);
    expect(response.modelVersion).toBe('fake-llm-001');
    expect(llm.requests).toHaveLength(1);
  });

  it('constrains output to the question labels and describes questions in systemInstruction', async () => {
    const {classifier, llm} = buildClassifier({
      route: {billing: 1, technical: 0},
      risky: {probability: 0.5},
    });

    await classifier.classify({
      input: 'x',
      questions: {
        route: ROUTE_QUESTION,
        risky: createBinary({criteria: 'Deletes user data'}),
      },
    });

    const config = llm.requests[0].config;
    expect(config?.responseMimeType).toBe('application/json');
    expect(config?.responseSchema).toMatchObject({
      type: Type.OBJECT,
      properties: {
        route: {
          type: Type.OBJECT,
          required: ['billing', 'technical'],
        },
      },
      required: ['route', 'risky'],
    });
    expect(config?.systemInstruction).toContain(
      'Which department handles this?',
    );
    expect(config?.systemInstruction).toContain(
      '- "billing": Invoices and refunds',
    );
    expect(config?.systemInstruction).toContain(
      'True means: Deletes user data\nAnything else is false.',
    );
  });

  it('sends JSON input as JSON text and Content input as user parts', async () => {
    const {classifier, llm} = buildClassifier({risky: {probability: 0.5}});

    await classifier.classify({
      input: {tool: 'pay', amount: 5},
      questions: {risky: createBinary()},
    });
    expect(llm.requests[0].contents[0].role).toBe('user');
    expect(
      JSON.parse(llm.requests[0].contents[0].parts?.[0]?.text ?? ''),
    ).toEqual({
      tool: 'pay',
      amount: 5,
    });

    const imagePart = {inlineData: {data: 'cG5n', mimeType: 'image/png'}};
    await classifier.classify({
      input: {role: 'model', parts: [imagePart]},
      questions: {risky: createBinary()},
    });
    expect(llm.requests[1].contents[0].role).toBe('user');
    expect(llm.requests[1].contents[0].parts).toEqual([imagePart]);
  });

  it('clones generateContentConfig (including httpOptions.fetch and abortSignal) without mutating the caller config', async () => {
    const llm = new FakeLlm({reply: {risky: {probability: 0.5}}});
    const customFetch: typeof fetch = async () => new Response('{}');
    const abortController = new AbortController();
    const callerConfig: GenerateContentConfig = {
      temperature: 0,
      abortSignal: abortController.signal,
      httpOptions: {
        fetch: customFetch,
        headers: {'x-custom': 'value'},
      },
    };
    const classifier = new LlmClassifier({
      model: llm,
      generateContentConfig: callerConfig,
    });

    await classifier.classify({
      input: 'x',
      questions: {risky: createBinary()},
    });

    expect(llm.requests[0].config?.temperature).toBe(0);
    expect(llm.requests[0].config?.abortSignal).toBe(abortController.signal);
    expect(llm.requests[0].config?.httpOptions?.fetch).toBe(customFetch);
    expect(llm.requests[0].config?.httpOptions?.headers?.['x-custom']).toBe(
      'value',
    );
    expect(callerConfig.systemInstruction).toBeUndefined();
    expect(callerConfig.responseSchema).toBeUndefined();
    expect(
      callerConfig.httpOptions?.headers?.['x-goog-api-client'],
    ).toBeUndefined();
  });

  it('resolves a string model name through LLMRegistry', async () => {
    class RegisteredFakeLlm extends FakeLlm {
      static override readonly supportedModels = ['registered-classifier-llm'];
      constructor({model}: {model: string}) {
        super({model, reply: {risky: {probability: 0.4}}});
      }
    }
    LLMRegistry.register(RegisteredFakeLlm);

    const classifier = new LlmClassifier({model: 'registered-classifier-llm'});
    const response = await classifier.classify({
      input: 'x',
      questions: {risky: createBinary()},
    });

    expect(response.answers['risky']).toEqual(
      createBinaryAnswer({probability: 0.4}),
    );
  });

  it('labels model calls as an llm classifier and preserves outer client labels', async () => {
    const {classifier, llm} = buildClassifier({risky: {probability: 0.9}});

    await classifier.classify({
      input: 'x',
      questions: {risky: createBinary()},
    });
    expect(llm.clientLabels[0][llm.clientLabels[0].length - 1]).toBe(
      classifierClientLabel('llm'),
    );
    expect(
      llm.requests[0].config?.httpOptions?.headers?.['x-goog-api-client'],
    ).toContain(classifierClientLabel('llm'));

    await runWithClientLabel('google-adk-eval/1.0.0', async () => {
      await classifier.classify({
        input: 'x',
        questions: {risky: createBinary()},
      });
    });
    expect(llm.clientLabels[1][llm.clientLabels[1].length - 1]).toBe(
      'google-adk-eval/1.0.0',
    );
  });

  it('rejects invalid responses, model errors, and invalid configurations', async () => {
    expect(
      () =>
        new LlmClassifier({
          model: new FakeLlm(),
          generateContentConfig: {responseSchema: {type: Type.OBJECT}},
        }),
    ).toThrow(/response schema/);

    expect(
      () =>
        new LlmClassifier({
          model: new FakeLlm(),
          generateContentConfig: {tools: []},
        }),
    ).toThrow(/tools/);

    const {classifier: emptyQuestionsClassifier} = buildClassifier({});
    await expect(
      emptyQuestionsClassifier.classify({input: 'x', questions: {}}),
    ).rejects.toThrow(/at least one question/);

    const {classifier: missingLabelClassifier} = buildClassifier({
      route: {billing: 1.0},
    });
    await expect(
      missingLabelClassifier.classify({
        input: 'x',
        questions: {route: ROUTE_QUESTION},
      }),
    ).rejects.toThrow(/technical/);

    const {classifier: badNumberClassifier} = buildClassifier({
      route: {billing: '0.4', technical: 0.5},
    });
    await expect(
      badNumberClassifier.classify({
        input: 'x',
        questions: {route: ROUTE_QUESTION},
      }),
    ).rejects.toThrow(/non-number/);

    const {classifier: outOfRangeBinary} = buildClassifier({
      risky: {probability: 70},
    });
    await expect(
      outOfRangeBinary.classify({
        input: 'x',
        questions: {risky: createBinary()},
      }),
    ).rejects.toThrow(/outside \[0, 1\]/);

    const {classifier: invalidJsonClassifier} = buildClassifier('not json');
    await expect(
      invalidJsonClassifier.classify({
        input: 'x',
        questions: {route: ROUTE_QUESTION},
      }),
    ).rejects.toThrow(/did not return valid JSON/);

    const {classifier: maxTokensClassifier} = buildClassifier(
      '{"route": {"bil',
      {
        finishReason: FinishReason.MAX_TOKENS,
        errorCode: 'MAX_TOKENS',
      },
    );
    await expect(
      maxTokensClassifier.classify({
        input: 'x',
        questions: {route: ROUTE_QUESTION},
      }),
    ).rejects.toThrow(/output tokens/);

    const {classifier: errorClassifier} = buildClassifier(
      {},
      {errorCode: 'RESOURCE_EXHAUSTED'},
    );
    await expect(
      errorClassifier.classify({
        input: 'x',
        questions: {route: ROUTE_QUESTION},
      }),
    ).rejects.toThrow(/RESOURCE_EXHAUSTED/);
  });
});
