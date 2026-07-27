/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '../agents/llm_agent.js';
import {SamplingResult} from './data_types.js';

/** Which example set to sample and score against. */
export type ExampleSet = 'train' | 'validation';

/**
 * Base class for optimizers to sample and score candidate agents.
 *
 * Developers implement this to plug their scoring/evaluation service into an
 * optimizer. The optimizer calls {@link sampleAndScore} to evaluate a candidate
 * agent on a batch of examples. Keeping scoring behind this interface means the
 * optimizer never decides what "good" means.
 *
 * @experimental
 */
export abstract class Sampler<T extends SamplingResult> {
  /** Returns the UIDs of examples to use for training the agent. */
  abstract getTrainExampleIds(): string[];

  /** Returns the UIDs of examples to use for validating the optimized agent. */
  abstract getValidationExampleIds(): string[];

  /**
   * Evaluates the candidate agent on a batch of examples.
   *
   * @param candidate The candidate agent to evaluate.
   * @param exampleSet The set to evaluate against (defaults to `'validation'`).
   * @param batch UIDs to evaluate; if omitted, uses all examples in the set.
   * @param captureFullEvalData If true, also capture data useful for
   *     optimization (e.g. trajectories, outputs, metrics). Defaults to false.
   * @returns The evaluation results, containing per-example scores.
   */
  abstract sampleAndScore(
    candidate: LlmAgent,
    exampleSet?: ExampleSet,
    batch?: string[],
    captureFullEvalData?: boolean,
  ): Promise<T>;
}
