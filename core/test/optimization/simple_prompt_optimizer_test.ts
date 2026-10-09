/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentOptimizer,
  AgentWithScores,
  BaseLlm,
  BaseLlmConnection,
  ExampleSet,
  getLogger,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Logger,
  OptimizerResult,
  ReadonlyContext,
  Sampler,
  setLogger,
  SimplePromptOptimizer,
  UnstructuredSamplingResult,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

/** An LLM stub that yields a fixed list of responses and counts calls. */
class MockLlm extends BaseLlm {
  callCount = 0;
  lastRequest?: LlmRequest;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'mock-optimizer'});
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.callCount++;
    this.lastRequest = request;
    for (const response of this.responses) {
      yield response;
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not supported in MockLlm');
  }
}

type ScoreFn = (
  candidate: LlmAgent,
  exampleSet: ExampleSet,
  ids: string[],
) => Record<string, number>;

interface StubSamplerOptions {
  trainIds: string[];
  validationIds: string[];
  score: ScoreFn;
}

/** A Sampler stub that records how it was called. */
class StubSampler extends Sampler<UnstructuredSamplingResult> {
  getTrainExampleIdsCallCount = 0;
  calls: Array<{exampleSet: ExampleSet; batch?: string[]}> = [];

  constructor(private readonly options: StubSamplerOptions) {
    super();
  }

  override getTrainExampleIds(): string[] {
    this.getTrainExampleIdsCallCount++;
    return this.options.trainIds;
  }

  override getValidationExampleIds(): string[] {
    return this.options.validationIds;
  }

  override async sampleAndScore(
    candidate: LlmAgent,
    exampleSet: ExampleSet = 'validation',
    batch?: string[],
    _captureFullEvalData = false,
  ): Promise<UnstructuredSamplingResult> {
    this.calls.push({exampleSet, batch});
    const ids =
      batch ??
      (exampleSet === 'train'
        ? this.options.trainIds
        : this.options.validationIds);
    return {scores: this.options.score(candidate, exampleSet, ids)};
  }
}

/** Scores `hi` when the instruction contains `keyword`, else `lo`. */
function keywordScorer(keyword: string, hi: number, lo: number): ScoreFn {
  return (candidate, _exampleSet, ids) => {
    const instruction = candidate.instruction as string;
    const value = instruction.includes(keyword) ? hi : lo;
    return Object.fromEntries(ids.map((id) => [id, value]));
  };
}

function textResponse(...texts: string[]): LlmResponse {
  return {content: {parts: texts.map((text) => ({text}))}};
}

describe('SimplePromptOptimizer', () => {
  it('adopts a better rewritten prompt and reports the validation score', async () => {
    const sampler = new StubSampler({
      trainIds: ['1', '2', '3', '4', '5'],
      validationIds: ['v1', 'v2'],
      score: keywordScorer('IMPROVED', 0.9, 0.5),
    });
    const llm = new MockLlm([textResponse('IMPROVED PROMPT')]);
    const optimizer = new SimplePromptOptimizer({
      optimizerModel: llm,
      numIterations: 2,
      batchSize: 2,
    });
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: 'Initial Prompt',
    });

    const result = await optimizer.optimize(initialAgent, sampler);

    expect(result.optimizedAgents).toHaveLength(1);
    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      'IMPROVED PROMPT',
    );
    expect(result.optimizedAgents[0].overallScore).toBe(0.9);
    // The original agent is untouched.
    expect(initialAgent.instruction).toBe('Initial Prompt');
    // 1 baseline + 2 iterations + 1 validation.
    expect(sampler.calls).toHaveLength(4);
    expect(sampler.getTrainExampleIdsCallCount).toBe(1);
    // One rewriter call per iteration.
    expect(llm.callCount).toBe(2);
    // Batches drawn from train are the requested size, unique, and in-set.
    const baselineBatch = sampler.calls[0].batch ?? [];
    expect(baselineBatch).toHaveLength(2);
    expect(new Set(baselineBatch).size).toBe(2);
    for (const id of baselineBatch) {
      expect(['1', '2', '3', '4', '5']).toContain(id);
    }
  });

  it('discards a candidate that does not beat the baseline', async () => {
    const sampler = new StubSampler({
      trainIds: ['1', '2', '3'],
      validationIds: ['v1'],
      score: keywordScorer('IMPROVED', 0.9, 0.5),
    });
    const llm = new MockLlm([textResponse('WORSE PROMPT')]);
    const optimizer = new SimplePromptOptimizer({
      optimizerModel: llm,
      numIterations: 1,
      batchSize: 2,
    });
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: 'Initial Prompt',
    });

    const result = await optimizer.optimize(initialAgent, sampler);

    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      'Initial Prompt',
    );
  });

  it('skips thought parts and parts without text when building the prompt', async () => {
    const sampler = new StubSampler({
      trainIds: ['1', '2', '3'],
      validationIds: ['v1'],
      score: keywordScorer('REAL', 0.9, 0.5),
    });
    // First response has no parts (exercises the skip); second mixes a thought
    // part, a text-less part, and the real prompt text.
    const llm = new MockLlm([
      {content: {}},
      {
        content: {
          parts: [
            {text: 'internal reasoning', thought: true},
            {functionCall: {name: 'noop'}},
            {text: 'REAL PROMPT'},
          ],
        },
      },
    ]);
    const optimizer = new SimplePromptOptimizer({
      optimizerModel: llm,
      numIterations: 1,
      batchSize: 2,
    });
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: 'start',
    });

    const result = await optimizer.optimize(initialAgent, sampler);

    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      'REAL PROMPT',
    );
  });

  it('warns and uses all training examples when batchSize is too large', async () => {
    const sampler = new StubSampler({
      trainIds: ['1', '2', '3'],
      validationIds: ['v1'],
      score: keywordScorer('IMPROVED', 0.9, 0.5),
    });
    const llm = new MockLlm([textResponse('IMPROVED PROMPT')]);
    const optimizer = new SimplePromptOptimizer({
      optimizerModel: llm,
      numIterations: 1,
      batchSize: 10,
    });
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: 'Initial Prompt',
    });
    const warnSpy = vi.fn();
    const stubLogger: Logger = {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      setLogLevel: vi.fn(),
    };
    const previousLogger = getLogger();
    setLogger(stubLogger);

    try {
      await optimizer.optimize(initialAgent, sampler);
    } finally {
      setLogger(previousLogger);
    }

    expect(warnSpy).toHaveBeenCalledOnce();
    // The batch is clamped to all training examples (a full permutation).
    const baselineBatch = sampler.calls[0].batch ?? [];
    expect([...baselineBatch].sort()).toEqual(['1', '2', '3']);
  });

  it('returns an overall score of 0 when validation yields no scores', async () => {
    const sampler = new StubSampler({
      trainIds: ['1', '2'],
      validationIds: ['v1'],
      score: (_candidate, exampleSet): Record<string, number> =>
        exampleSet === 'validation' ? {} : {'1': 0.5, '2': 0.5},
    });
    const llm = new MockLlm([textResponse('anything')]);
    const optimizer = new SimplePromptOptimizer({
      optimizerModel: llm,
      numIterations: 1,
      batchSize: 2,
    });
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: 'Initial Prompt',
    });

    const result = await optimizer.optimize(initialAgent, sampler);

    expect(result.optimizedAgents[0].overallScore).toBe(0);
  });

  it('averages validation scores for the overall score', async () => {
    const sampler = new StubSampler({
      trainIds: ['1', '2'],
      validationIds: ['a', 'b'],
      score: (_candidate, exampleSet): Record<string, number> =>
        exampleSet === 'validation' ? {a: 1, b: 0} : {'1': 0.5, '2': 0.5},
    });
    const optimizer = new SimplePromptOptimizer({
      optimizerModel: new MockLlm([textResponse('unused')]),
      numIterations: 0,
      batchSize: 2,
    });
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: 'Initial Prompt',
    });

    const result = await optimizer.optimize(initialAgent, sampler);

    expect(result.optimizedAgents[0].overallScore).toBe(0.5);
  });

  it('throws when the initial instruction is not a string', async () => {
    const sampler = new StubSampler({
      trainIds: ['1'],
      validationIds: ['v1'],
      score: keywordScorer('IMPROVED', 0.9, 0.5),
    });
    const llm = new MockLlm([textResponse('IMPROVED PROMPT')]);
    const optimizer = new SimplePromptOptimizer({optimizerModel: llm});
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: (_context: ReadonlyContext) => 'dynamic instruction',
    });

    await expect(optimizer.optimize(initialAgent, sampler)).rejects.toThrow(
      'SimplePromptOptimizer supports only string instructions',
    );
    // Fails fast: no rewriter or sampler calls were made.
    expect(llm.callCount).toBe(0);
    expect(sampler.calls).toHaveLength(0);
  });

  it('sends the configured model configuration on the request', async () => {
    const sampler = new StubSampler({
      trainIds: ['1', '2'],
      validationIds: ['v1'],
      score: keywordScorer('IMPROVED', 0.9, 0.5),
    });
    const llm = new MockLlm([textResponse('IMPROVED PROMPT')]);
    const modelConfiguration = {temperature: 0.2};
    const optimizer = new SimplePromptOptimizer({
      optimizerModel: llm,
      modelConfiguration,
      numIterations: 1,
      batchSize: 2,
    });
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: 'Initial Prompt',
    });

    await optimizer.optimize(initialAgent, sampler);

    expect(llm.lastRequest?.config).toBe(modelConfiguration);
    expect(llm.lastRequest?.model).toBe('mock-optimizer');
  });

  it('resolves the default string model via the LLM registry', () => {
    // With no optimizerModel, the default string is resolved via LLMRegistry
    // (Gemini construction only reads the key; it makes no network call here).
    const previousKey = process.env.GOOGLE_GENAI_API_KEY;
    process.env.GOOGLE_GENAI_API_KEY = 'test-api-key';
    try {
      const optimizer = new SimplePromptOptimizer();
      expect(optimizer).toBeInstanceOf(SimplePromptOptimizer);
      expect(optimizer).toBeInstanceOf(AgentOptimizer);
    } finally {
      if (previousKey === undefined) {
        delete process.env.GOOGLE_GENAI_API_KEY;
      } else {
        process.env.GOOGLE_GENAI_API_KEY = previousKey;
      }
    }
  });

  it('supports custom AgentOptimizer subclasses', () => {
    // A custom optimizer subclass satisfies the AgentOptimizer contract.
    class NoopOptimizer extends AgentOptimizer<
      UnstructuredSamplingResult,
      AgentWithScores
    > {
      override async optimize(
        initialAgent: LlmAgent,
      ): Promise<OptimizerResult<AgentWithScores>> {
        return {optimizedAgents: [{optimizedAgent: initialAgent}]};
      }
    }
    expect(new NoopOptimizer()).toBeInstanceOf(AgentOptimizer);
  });
});
