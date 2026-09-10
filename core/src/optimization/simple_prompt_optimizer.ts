/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {LlmAgent} from '../agents/llm_agent.js';
import {BaseLlm, isBaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {LLMRegistry} from '../models/registry.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {AgentOptimizer} from './agent_optimizer.js';
import {
  AgentWithScores,
  OptimizerResult,
  UnstructuredSamplingResult,
} from './data_types.js';
import {Sampler} from './sampler.js';

/** Default model used to rewrite prompts. */
const DEFAULT_OPTIMIZER_MODEL = 'gemini-2.5-flash';
/** Default number of optimization rounds. */
const DEFAULT_NUM_ITERATIONS = 10;
/** Default number of training examples used to score each candidate. */
const DEFAULT_BATCH_SIZE = 5;
/** Default thinking budget (tokens) for the optimizer model. */
const DEFAULT_THINKING_BUDGET = 10240;

/**
 * Prompt template sent to the optimizer model. `{currentScore}` and
 * `{currentPromptText}` are interpolated before use.
 */
const OPTIMIZER_PROMPT_TEMPLATE = `
You are an expert prompt engineer. Your task is to improve the system prompt for an AI agent.
The agent's current prompt achieved an average score of {currentScore} on a set of evaluation tasks. A higher score is better.

Here is the current prompt:
<current_prompt>
{currentPromptText}
</current_prompt>

Based on the current prompt, rewrite it to create a new, improved version that is likely to achieve a higher score.
The agent needs to solve customer support tasks by using tools correctly and following policies.
Focus on clarity, structure, and providing actionable guidance for the agent.

**Output only the new, full, improved agent prompt. Do not add any other text, explanations, or markdown formatting.**
`;

/**
 * Configuration for {@link SimplePromptOptimizer}.
 *
 * @experimental
 */
export interface SimplePromptOptimizerConfig {
  /**
   * Model used to rewrite prompts. A string is resolved via {@link LLMRegistry};
   * a {@link BaseLlm} instance is used directly (which enables no-network
   * tests). Defaults to `'gemini-2.5-flash'`.
   */
  optimizerModel?: string | BaseLlm;

  /**
   * Config for the optimizer model. Defaults to a thinking config with
   * `includeThoughts: true` and a thinking budget of 10240 tokens.
   */
  modelConfiguration?: GenerateContentConfig;

  /** Number of optimization rounds. Defaults to 10. */
  numIterations?: number;

  /** Training examples used to score each candidate. Defaults to 5. */
  batchSize?: number;
}

/**
 * A naive optimizer that iteratively tries to improve an agent's prompt.
 *
 * Each round it asks an LLM to rewrite the agent's `instruction` (telling it the
 * current score), builds a candidate via `clone({instruction})`, scores it on a
 * random batch of training examples, and keeps it only if it beats the current
 * best. After `numIterations` rounds it scores the winner on the validation set
 * and returns it.
 *
 * Scoring is pluggable: the developer supplies a {@link Sampler}; this optimizer
 * never decides what "good" means.
 *
 * Note: running this is not free. With the defaults (10 iterations, batch size
 * 5) a single run performs 50+ candidate scoring runs plus ~10 rewriter model
 * calls, so expect real cost and latency.
 *
 * @experimental
 */
@experimental
export class SimplePromptOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  private readonly llm: BaseLlm;
  private readonly optimizerModelName: string;
  private readonly modelConfiguration: GenerateContentConfig;
  private readonly numIterations: number;
  private batchSize: number;

  constructor(config: SimplePromptOptimizerConfig = {}) {
    super();
    const model = config.optimizerModel ?? DEFAULT_OPTIMIZER_MODEL;
    this.llm = isBaseLlm(model) ? model : LLMRegistry.newLlm(model);
    this.optimizerModelName = this.llm.model;
    this.modelConfiguration = config.modelConfiguration ?? {
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: DEFAULT_THINKING_BUDGET,
      },
    };
    this.numIterations = config.numIterations ?? DEFAULT_NUM_ITERATIONS;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  override async optimize(
    initialAgent: LlmAgent,
    sampler: Sampler<UnstructuredSamplingResult>,
  ): Promise<OptimizerResult<AgentWithScores>> {
    // Fail fast before any LLM or sampler calls.
    requireStringInstruction(initialAgent);

    const trainExampleIds = sampler.getTrainExampleIds();
    if (this.batchSize > trainExampleIds.length) {
      logger.warn(
        `Batch size (${this.batchSize}) is larger than the number of training ` +
          `examples (${trainExampleIds.length}). Using all training examples ` +
          `for each evaluation.`,
      );
      this.batchSize = trainExampleIds.length;
    }

    const {bestAgent} = await this.runOptimizationIterations(
      initialAgent,
      sampler,
      trainExampleIds,
    );

    const finalScore = await this.runFinalValidation(bestAgent, sampler);

    return {
      optimizedAgents: [{optimizedAgent: bestAgent, overallScore: finalScore}],
    };
  }

  /** Generates a new prompt candidate using the optimizer LLM. */
  private async generateCandidatePrompt(
    bestAgent: LlmAgent,
    bestScore: number,
  ): Promise<string> {
    const currentPrompt = requireStringInstruction(bestAgent);
    const promptForOptimizer = OPTIMIZER_PROMPT_TEMPLATE.replace(
      '{currentScore}',
      bestScore.toFixed(2),
    ).replace('{currentPromptText}', currentPrompt);

    const llmRequest: LlmRequest = {
      model: this.optimizerModelName,
      config: this.modelConfiguration,
      contents: [{role: 'user', parts: [{text: promptForOptimizer}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    let responseText = '';
    for await (const llmResponse of this.llm.generateContentAsync(llmRequest)) {
      const parts = llmResponse.content?.parts;
      if (!parts) {
        continue;
      }
      for (const part of parts) {
        // Skip thought parts so reasoning never leaks into the new prompt.
        if (part.text && !part.thought) {
          responseText += part.text;
        }
      }
    }
    return responseText;
  }

  /** Scores the agent on a random batch of training examples. */
  private async scoreAgentOnBatch(
    agent: LlmAgent,
    sampler: Sampler<UnstructuredSamplingResult>,
    exampleIds: string[],
  ): Promise<number> {
    const evalBatch = randomSample(exampleIds, this.batchSize);
    const results = await sampler.sampleAndScore(
      agent,
      'train',
      evalBatch,
      false,
    );
    return meanScore(results.scores);
  }

  /** Runs the optimization loop and returns the best agent and its score. */
  private async runOptimizationIterations(
    initialAgent: LlmAgent,
    sampler: Sampler<UnstructuredSamplingResult>,
    trainExampleIds: string[],
  ): Promise<{bestAgent: LlmAgent; bestScore: number}> {
    let bestAgent = initialAgent;
    let bestScore = await this.scoreAgentOnBatch(
      bestAgent,
      sampler,
      trainExampleIds,
    );

    for (let i = 0; i < this.numIterations; i++) {
      const newPrompt = await this.generateCandidatePrompt(
        bestAgent,
        bestScore,
      );
      const candidate = bestAgent.clone({instruction: newPrompt});
      const candidateScore = await this.scoreAgentOnBatch(
        candidate,
        sampler,
        trainExampleIds,
      );
      if (candidateScore > bestScore) {
        bestAgent = candidate;
        bestScore = candidateScore;
      }
    }
    return {bestAgent, bestScore};
  }

  /** Runs final validation on the best agent found. */
  private async runFinalValidation(
    bestAgent: LlmAgent,
    sampler: Sampler<UnstructuredSamplingResult>,
  ): Promise<number> {
    const results = await sampler.sampleAndScore(bestAgent, 'validation');
    return meanScore(results.scores);
  }
}

/**
 * Returns the agent's instruction as a string, throwing if it is an
 * `InstructionProvider` (a provider function cannot be embedded as prompt text).
 */
function requireStringInstruction(agent: LlmAgent): string {
  if (typeof agent.instruction !== 'string') {
    throw new Error(
      'SimplePromptOptimizer supports only string instructions; got an ' +
        'InstructionProvider.',
    );
  }
  return agent.instruction;
}

/**
 * Returns `k` unique elements sampled without replacement, like Python's
 * `random.sample`. Callers must pass `k <= items.length`.
 */
function randomSample<T>(items: T[], k: number): T[] {
  const pool = [...items];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

/** Returns the mean of the score values, or 0 when there are none. */
function meanScore(scores: Record<string, number>): number {
  const values = Object.values(scores);
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
