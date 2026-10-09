/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '../agents/llm_agent.js';

/**
 * Base evaluation result: per-example scores (higher is better).
 *
 * @experimental
 */
export interface SamplingResult {
  /** Map from example UID to the agent's overall score on that example. */
  scores: Record<string, number>;
}

/**
 * Evaluation result with optional per-example unstructured data.
 *
 * @experimental
 */
export interface UnstructuredSamplingResult extends SamplingResult {
  /**
   * Map from example UID to JSON-serializable data useful for optimization
   * (e.g. inputs, trajectories, and metrics).
   */
  data?: Record<string, Record<string, unknown>>;
}

/**
 * An optimized agent together with its scores.
 *
 * @experimental
 */
export interface AgentWithScores {
  /** The optimized agent. */
  optimizedAgent: LlmAgent;
  /** The overall score of the optimized agent (e.g. mean validation score). */
  overallScore?: number;
}

/**
 * Base optimizer result: a Pareto-front of optimized agents that cannot be
 * considered strictly better than one another
 * (https://en.wikipedia.org/wiki/Pareto_front), along with their scores.
 *
 * @experimental
 */
export interface OptimizerResult<T extends AgentWithScores = AgentWithScores> {
  /** The optimized agents produced by the run. */
  optimizedAgents: T[];
}
