/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '../agents/llm_agent.js';
import {
  AgentWithScores,
  OptimizerResult,
  SamplingResult,
} from './data_types.js';
import {Sampler} from './sampler.js';

/**
 * Base class for agent optimizers.
 *
 * @experimental
 */
export abstract class AgentOptimizer<
  S extends SamplingResult,
  A extends AgentWithScores,
> {
  /**
   * Runs the optimizer.
   *
   * @param initialAgent The initial agent to optimize.
   * @param sampler Used to get train/validation example UIDs and to score
   *     candidate agents.
   * @returns The optimized agents along with their scores.
   */
  abstract optimize(
    initialAgent: LlmAgent,
    sampler: Sampler<S>,
  ): Promise<OptimizerResult<A>>;
}
