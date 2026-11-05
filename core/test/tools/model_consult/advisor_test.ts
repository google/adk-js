/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FinishReason,
  GenerateContentConfig,
  Part,
  ThinkingLevel,
} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {BaseLlm} from '../../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../../src/models/llm_request.js';
import {LlmResponse} from '../../../src/models/llm_response.js';
import {
  AdvisorError,
  AdvisorUsage,
  callAdvisor,
  resolveAdvisorLlm,
  resolveThinkingLevel,
} from '../../../src/tools/model_consult/advisor.js';

function textResponse(
  text = '1. Diagnosis. 2. Plan. 3. Watch out.',
  options: {
    thought?: string;
    promptTokens?: number;
    outputTokens?: number;
    thoughtsTokens?: number;
    modelVersion?: string;
    partial?: boolean;
    errorCode?: string;
    errorMessage?: string;
    finishReason?: FinishReason;
  } = {},
): LlmResponse {
  const {
    thought,
    promptTokens = 1000,
    outputTokens = 120,
    thoughtsTokens = 50,
    modelVersion = 'fake-advisor-001',
    partial,
    errorCode,
    errorMessage,
    finishReason,
  } = options;
  const parts: Part[] = [];
  if (thought !== undefined) {
    parts.push({text: thought, thought: true});
  }
  if (text !== '') {
    parts.push({text});
  }
  return {
    modelVersion,
    content: parts.length > 0 ? {role: 'model', parts} : undefined,
    partial,
    errorCode,
    errorMessage,
    finishReason,
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: outputTokens,
      thoughtsTokenCount: thoughtsTokens,
      totalTokenCount: promptTokens + outputTokens + thoughtsTokens,
    },
  };
}

class FakeAdvisorLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private readonly responses: LlmResponse[];
  private readonly errors: Array<Error | null>;
  private readonly delaySeconds: number;
  private callIndex = 0;

  constructor(
    options: {
      model?: string;
      responses?: LlmResponse[];
      errors?: Array<Error | null>;
      delaySeconds?: number;
    } = {},
  ) {
    super({model: options.model ?? 'fake-advisor'});
    this.responses = options.responses ?? [textResponse()];
    this.errors = options.errors ?? [];
    this.delaySeconds = options.delaySeconds ?? 0;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(llmRequest);
    const idx = this.callIndex;
    this.callIndex += 1;
    if (this.delaySeconds > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.delaySeconds * 1000),
      );
    }
    if (idx < this.errors.length && this.errors[idx] !== null) {
      throw this.errors[idx]!;
    }
    const resp =
      idx < this.responses.length
        ? this.responses[idx]
        : this.responses[this.responses.length - 1];
    yield resp;
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

class MultiYieldLlm extends BaseLlm {
  private readonly seq: LlmResponse[];

  constructor(seq: LlmResponse[]) {
    super({model: 'multi'});
    this.seq = seq;
  }

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void, void> {
    for (const item of this.seq) {
      yield item;
    }
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

describe('advisor', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
    ['none', undefined],
    ['off', undefined],
    [ThinkingLevel.THINKING_LEVEL_UNSPECIFIED, undefined],
    ['minimal', ThinkingLevel.MINIMAL],
    ['LOW', ThinkingLevel.LOW],
    [' medium ', ThinkingLevel.MEDIUM],
    ['high', ThinkingLevel.HIGH],
    [ThinkingLevel.HIGH, ThinkingLevel.HIGH],
  ])('resolveThinkingLevel(%s) returns %s', (raw, expected) => {
    expect(resolveThinkingLevel(raw)).toBe(expected);
  });

  it('resolveThinkingLevel rejects unknown value', () => {
    expect(() => resolveThinkingLevel('ultra')).toThrow(
      /Invalid advisor thinking_level/,
    );
  });

  it('resolveAdvisorLlm validates input', () => {
    const fake = new FakeAdvisorLlm();
    expect(resolveAdvisorLlm(fake)).toBe(fake);
    expect(() => resolveAdvisorLlm('   ')).toThrow(/Invalid advisor_model/);
    expect(() => resolveAdvisorLlm(123 as unknown as string)).toThrow(
      /Invalid advisor_model/,
    );
  });

  it('AdvisorUsage.fromMetadata handles missing and partial metadata', () => {
    expect(AdvisorUsage.fromMetadata(undefined).toDict()).toEqual({
      prompt_tokens: 0,
      output_tokens: 0,
      thoughts_tokens: 0,
      cached_tokens: 0,
      total_tokens: 0,
    });
    const u1 = new AdvisorUsage({promptTokens: 10, outputTokens: 5});
    const u2 = new AdvisorUsage({
      promptTokens: 20,
      thoughtsTokens: 3,
      totalTokens: 28,
    });
    expect(u1.add(u2).toDict()).toEqual({
      prompt_tokens: 30,
      output_tokens: 5,
      thoughts_tokens: 3,
      cached_tokens: 0,
      total_tokens: 28,
    });
  });

  it('callAdvisor filters partial chunks and thoughts and preserves includeThoughts', async () => {
    const llm = new MultiYieldLlm([
      textResponse('partial chunk', {partial: true}),
      textResponse('final guidance', {thought: 'hidden internal reasoning'}),
    ]);
    const callerCfg: GenerateContentConfig = {
      thinkingConfig: {includeThoughts: true},
    };
    const contents: Content[] = [{role: 'user', parts: [{text: 'q'}]}];

    const result = await callAdvisor(llm, contents, {
      thinkingLevel: 'high',
      generateContentConfig: callerCfg,
    });

    expect(result.guidance).toBe('final guidance');
    expect(result.thinkingLevel).toBe('high');
  });

  it('callAdvisor raises AdvisorError on errorCode or empty response', async () => {
    const contents: Content[] = [{role: 'user', parts: [{text: 'q'}]}];

    const errLlm = new FakeAdvisorLlm({
      responses: [
        textResponse('', {
          errorCode: '429',
          errorMessage: 'rate limit exceeded',
        }),
      ],
    });
    await expect(callAdvisor(errLlm, contents)).rejects.toThrow(
      /returned error \(429\): rate limit exceeded/,
    );

    const emptyLlm = new FakeAdvisorLlm({
      responses: [textResponse('', {thought: 'only thought, no text'})],
    });
    await expect(callAdvisor(emptyLlm, contents)).rejects.toThrow(
      /returned an empty response/,
    );
  });

  it('callAdvisor reports thought starvation on MAX_TOKENS without text', async () => {
    const contents: Content[] = [{role: 'user', parts: [{text: 'q'}]}];
    const starvedLlm = new FakeAdvisorLlm({
      responses: [
        textResponse('', {
          thought: 'spent entire token budget thinking...',
          finishReason: FinishReason.MAX_TOKENS,
          errorCode: 'MAX_TOKENS',
        }),
      ],
    });

    await expect(callAdvisor(starvedLlm, contents)).rejects.toThrow(
      /hit max_output_tokens before producing any visible guidance/,
    );
  });

  it('callAdvisor appends truncation notice on MAX_TOKENS with partial text', async () => {
    const contents: Content[] = [{role: 'user', parts: [{text: 'q'}]}];
    const truncatedLlm = new FakeAdvisorLlm({
      responses: [
        textResponse('1. Partial diagnosis before hitting limit', {
          finishReason: FinishReason.MAX_TOKENS,
          errorCode: 'MAX_TOKENS',
        }),
      ],
    });

    const result = await callAdvisor(truncatedLlm, contents);

    expect(result.guidance).toContain(
      '1. Partial diagnosis before hitting limit',
    );
    expect(result.guidance).toContain(
      '[advisor guidance truncated at max_output_tokens]',
    );
  });

  it('callAdvisor validates timeout and retry failures', async () => {
    const contents: Content[] = [{role: 'user', parts: [{text: 'q'}]}];
    const llm = new FakeAdvisorLlm();

    await expect(
      callAdvisor(llm, contents, {timeoutSeconds: 0}),
    ).rejects.toThrow(/timeout_seconds must be > 0/);

    // Fallback retry that itself raises a runtime error.
    const retryErrLlm = new FakeAdvisorLlm({
      errors: [
        new Error('thinking_config is unsupported'),
        new Error('second attempt boom'),
      ],
    });
    await expect(
      callAdvisor(retryErrLlm, contents, {thinkingLevel: 'high'}),
    ).rejects.toThrow(/second attempt boom/);

    // Fallback retry that itself times out.
    const retryTimeoutLlm = new FakeAdvisorLlm({
      errors: [new Error('thinking_config is invalid'), null],
      delaySeconds: 0.05,
    });
    await expect(
      callAdvisor(retryTimeoutLlm, contents, {
        thinkingLevel: 'high',
        timeoutSeconds: 0.06,
      }),
    ).rejects.toThrow(/timed out/);
    try {
      await callAdvisor(retryTimeoutLlm, contents, {
        thinkingLevel: 'high',
        timeoutSeconds: 0.06,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(AdvisorError);
    }
  });
});
