/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runnable sample / manual integration test for {@link SimplePromptOptimizer}.
 *
 * It builds an `LlmAgent`, implements a small deterministic `Sampler` (a
 * heuristic scorer that needs no credentials), and runs the optimizer with a
 * self-contained rewriter model so the whole sample runs offline. To try it
 * against a real model instead, replace `optimizerModel` with
 * `'gemini-2.5-flash'` and set `GOOGLE_GENAI_API_KEY` (or `GEMINI_API_KEY`).
 *
 * Run it directly, e.g. `npx tsx dev/samples/simple_prompt_optimizer.ts`.
 *
 * COST WARNING: with a real model this is not free to run. The defaults (10
 * iterations, batch size 5) perform 50+ candidate scoring runs plus ~10
 * rewriter model calls per optimize() call, so expect real cost and latency.
 */

import {fileURLToPath} from 'node:url';

import {
  BaseLlm,
  BaseLlmConnection,
  ExampleSet,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Sampler,
  SimplePromptOptimizer,
  UnstructuredSamplingResult,
} from '@google/adk';

/** Keywords the heuristic scorer rewards a prompt for containing. */
const DESIRED_KEYWORDS = ['step by step', 'policy', 'tools', 'concise'];

/** A stronger instruction the offline rewriter converges toward. */
const IMPROVED_INSTRUCTION = [
  'You are a diligent customer support agent.',
  'Work through each request step by step.',
  'Always follow company policy and use the available tools correctly.',
  'Keep your final answer concise.',
].join(' ');

/** Scores an instruction in [0, 1] by keyword coverage. */
function scoreInstruction(instruction: string): number {
  const lower = instruction.toLowerCase();
  const found = DESIRED_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  return found / DESIRED_KEYWORDS.length;
}

/**
 * A self-contained rewriter model that returns a stronger instruction, so the
 * sample runs without credentials or network access.
 */
class HeuristicRewriterLlm extends BaseLlm {
  constructor() {
    super({model: 'heuristic-rewriter'});
  }

  override async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: IMPROVED_INSTRUCTION}]}};
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not supported by HeuristicRewriterLlm');
  }
}

/** A deterministic sampler that scores candidates by keyword coverage. */
class HeuristicSampler extends Sampler<UnstructuredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return ['t1', 't2', 't3', 't4', 't5'];
  }

  override getValidationExampleIds(): string[] {
    return ['v1', 'v2', 'v3'];
  }

  override async sampleAndScore(
    candidate: LlmAgent,
    exampleSet: ExampleSet = 'validation',
    batch?: string[],
    _captureFullEvalData = false,
  ): Promise<UnstructuredSamplingResult> {
    const ids =
      batch ??
      (exampleSet === 'train'
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const score = scoreInstruction(candidate.instruction as string);
    return {scores: Object.fromEntries(ids.map((id) => [id, score]))};
  }
}

async function main(): Promise<void> {
  const agent = new LlmAgent({
    name: 'support_agent',
    model: 'gemini-2.5-flash',
    instruction: 'You are a customer support agent.',
  });

  const optimizer = new SimplePromptOptimizer({
    optimizerModel: new HeuristicRewriterLlm(),
    numIterations: 3,
    batchSize: 3,
  });

  const result = await optimizer.optimize(agent, new HeuristicSampler());
  const best = result.optimizedAgents[0];

  console.log('Original instruction:\n ', agent.instruction);
  console.log('\nOptimized instruction:\n ', best.optimizedAgent.instruction);
  console.log('\nValidation score:', best.overallScore);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
