/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  BaseClassifier,
  BaseLlm,
  BaseLlmConnection,
  ClassifierRequest,
  ClassifierResponse,
  createBinary,
  createBinaryAnswer,
  createClassifierResponse,
  FeatureName,
  getClientLabels,
  isBaseClassifier,
  LlmRequest,
  LlmResponse,
  runWithClientLabel,
  withTemporaryFeatureOverride,
} from '../../src/index.js';
import {classifierClientLabel} from '../../src/utils/client_labels.js';

class ConstantClassifier extends BaseClassifier {
  constructor(model: string | BaseLlm = 'constant') {
    super({model});
  }

  protected override async classifyImpl({
    questions,
  }: ClassifierRequest): Promise<ClassifierResponse> {
    const answers = Object.fromEntries(
      Object.keys(questions).map((name) => [
        name,
        createBinaryAnswer({probability: 0.5}),
      ]),
    );
    return createClassifierResponse({
      modelVersion: this.name,
      answers,
    });
  }
}

class LabelRecordingClassifier extends BaseClassifier {
  recordedLabels: string[] = [];

  constructor() {
    super({model: 'recording'});
  }

  protected override async classifyImpl(): Promise<ClassifierResponse> {
    this.recordedLabels = getClientLabels();
    return createClassifierResponse({answers: {}});
  }
}

class StubLlm extends BaseLlm {
  constructor() {
    super({model: 'stub-llm'});
  }

  // eslint-disable-next-line require-yield -- minimal stub for BaseLlm
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    return;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not supported');
  }
}

describe('BaseClassifier', () => {
  it('answers questions through classify and satisfies isBaseClassifier', async () => {
    const classifier = new ConstantClassifier();
    expect(isBaseClassifier(classifier)).toBe(true);
    expect(isBaseClassifier({})).toBe(false);

    const response = await classifier.classify({
      input: 'x',
      questions: {risky: createBinary()},
    });
    expect(response).toEqual(
      createClassifierResponse({
        modelVersion: 'constant',
        answers: {risky: createBinaryAnswer({probability: 0.5})},
      }),
    );
  });

  it('runs classify with the classifier client label and restores context afterwards', async () => {
    const classifier = new LabelRecordingClassifier();
    await classifier.classify({
      input: 'x',
      questions: {risky: createBinary()},
    });

    expect(
      classifier.recordedLabels[classifier.recordedLabels.length - 1],
    ).toBe(classifierClientLabel('custom'));
    expect(getClientLabels()).not.toContain(classifierClientLabel('custom'));
  });

  it('preserves an outer client label when one is already active', async () => {
    const classifier = new LabelRecordingClassifier();
    await runWithClientLabel('google-adk-eval/test', async () => {
      await classifier.classify({
        input: 'x',
        questions: {risky: createBinary()},
      });
    });

    expect(
      classifier.recordedLabels[classifier.recordedLabels.length - 1],
    ).toBe('google-adk-eval/test');
  });

  it('accepts a BaseLlm instance and exposes its model name', () => {
    const llm = new StubLlm();
    const classifier = new ConstantClassifier(llm);
    expect(classifier.model).toBe(llm);
    expect(classifier.name).toBe('stub-llm');
  });

  it('rejects an empty or whitespace-only model name', () => {
    expect(() => new ConstantClassifier('')).toThrow(/non-empty model name/);
    expect(() => new ConstantClassifier('   ')).toThrow(/non-empty model name/);
  });

  it('throws when the CLASSIFIER feature is disabled', async () => {
    await withTemporaryFeatureOverride(FeatureName.CLASSIFIER, false, () => {
      expect(() => new ConstantClassifier()).toThrow(/CLASSIFIER/);
    });
  });
});
