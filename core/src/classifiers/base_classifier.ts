/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {BaseLlm, isBaseLlm} from '../models/base_llm.js';
import {
  classifierClientLabel,
  runWithDefaultClientLabel,
} from '../utils/client_labels.js';
import {experimental} from '../utils/experimental.js';
import type {ClassifierRequest, ClassifierResponse} from './types.js';

const BASE_CLASSIFIER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.classifiers.baseClassifier',
);

/**
 * Throws when the classifier feature is disabled via feature overrides or
 * `ADK_DISABLE_CLASSIFIER`.
 */
export function checkClassifierEnabled(): void {
  if (!isFeatureEnabled(FeatureName.CLASSIFIER)) {
    throw new Error(`Feature ${FeatureName.CLASSIFIER} is not enabled.`);
  }
}

/** Configuration for constructing a {@link BaseClassifier}. */
export interface BaseClassifierConfig {
  /** The provider's model name, or a {@link BaseLlm} instance. */
  readonly model: string | BaseLlm;
}

/** Alias for {@link BaseClassifierConfig}. */
export type BaseClassifierParams = BaseClassifierConfig;

/**
 * Type guard to check if an object is an instance of {@link BaseClassifier}.
 */
export function isBaseClassifier(obj: unknown): obj is BaseClassifier {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_CLASSIFIER_SIGNATURE_SYMBOL in obj &&
    obj[BASE_CLASSIFIER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A decision model that answers typed questions with probability distributions.
 *
 * Unlike a {@link BaseLlm}, a classifier does not generate text, stream, or
 * call tools. It takes an input and a map of `Choice`, `Binary`, and `Score`
 * questions, and returns a probability distribution over the possible answers
 * to each. Dedicated decision models implement it directly; `LlmClassifier`
 * implements it on top of any {@link BaseLlm}.
 *
 * Classifiers are stateless: context from earlier conversation turns must be
 * included in the input passed to {@link classify}.
 */
@experimental
export abstract class BaseClassifier {
  readonly [BASE_CLASSIFIER_SIGNATURE_SYMBOL] = true;

  /** The provider's model name, or a {@link BaseLlm} instance. */
  readonly model: string | BaseLlm;

  /**
   * Names the classifier kind in the client label of requests sent inside
   * {@link classify}.
   */
  protected readonly clientLabelKind: string = 'custom';

  constructor(config: BaseClassifierConfig) {
    checkClassifierEnabled();
    if (
      !config ||
      (typeof config.model !== 'string' && !isBaseLlm(config.model)) ||
      (typeof config.model === 'string' && config.model.trim().length === 0)
    ) {
      throw new Error(
        'Classifier requires a non-empty model name or BaseLlm instance.',
      );
    }
    this.model = config.model;
  }

  /** Returns the provider's model name. */
  get name(): string {
    return typeof this.model === 'string' ? this.model : this.model.model;
  }

  /**
   * Answers every question in `request.questions` against `request.input`.
   *
   * Runs inside the classifier's client-label context unless an outer client
   * label (such as an evaluation label) is already set.
   */
  async classify(request: ClassifierRequest): Promise<ClassifierResponse> {
    const label = classifierClientLabel(this.clientLabelKind);
    return runWithDefaultClientLabel(label, () => this.classifyImpl(request));
  }

  /**
   * Subclass implementation of {@link classify}.
   */
  protected abstract classifyImpl(
    request: ClassifierRequest,
  ): Promise<ClassifierResponse>;
}
