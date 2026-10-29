/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ConversationScenario, Invocation} from './eval_case.js';
import {RubricScore} from './eval_rubrics.js';

/**
 * Outcome status of an evaluation metric or case.
 */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/** Metric evaluation score of a single invocation. */
export interface PerInvocationResult {
  /** The invocation obtained from the agent under test. */
  actualInvocation: Invocation;

  /** The golden invocation that the actual one was compared against. */
  expectedInvocation?: Invocation;

  /** The score, or undefined when the invocation was not scored. */
  score?: number;

  /** The status derived from the score and the metric threshold. */
  evalStatus: EvalStatus;

  /** The rubric verdicts and explanations behind the score. */
  rubricScores?: RubricScore[];
}

/** The result of evaluating a list of invocations against one metric. */
export interface EvaluationResult {
  /** Overall score, based on each invocation. */
  overallScore?: number;

  /** Overall status, based on each invocation. */
  overallEvalStatus: EvalStatus;

  /** Detailed results per invocation. */
  perInvocationResults: PerInvocationResult[];

  /** Overall rubric scores, based on each invocation. */
  overallRubricScores?: RubricScore[];
}

/**
 * Rejects invocation lists that cannot be paired without truncation.
 *
 * @param actualInvocations The invocations obtained from the agent under test.
 * @param expectedInvocations The optional golden invocations.
 * @throws If `expectedInvocations` is given and its length differs from the
 *   length of `actualInvocations`.
 */
export function validateInvocationLengths(
  actualInvocations: readonly Invocation[],
  expectedInvocations?: readonly Invocation[],
): void {
  if (
    expectedInvocations !== undefined &&
    actualInvocations.length !== expectedInvocations.length
  ) {
    throw new Error(
      'actualInvocations and expectedInvocations must have the same length; ' +
        `got ${actualInvocations.length} and ${expectedInvocations.length}.`,
    );
  }
}

/** A metrics evaluator. */
export abstract class Evaluator {
  /**
   * Returns the evaluation result for the actual invocations, compared to the
   * expected invocations when they are given.
   *
   * @param actualInvocations The invocations obtained from the agent under
   *   test.
   * @param expectedInvocations Optional golden invocations that act as a
   *   benchmark. When given, the usual expectation is that this list and
   *   `actualInvocations` have the same length.
   * @param conversationScenario An optional conversation scenario for
   *   multi-turn conversations.
   */
  abstract evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> | EvaluationResult;
}
