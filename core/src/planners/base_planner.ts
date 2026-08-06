/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';

/**
 * A unique symbol to identify ADK planner classes.
 * Defined once and shared by all BasePlanner instances.
 */
const BASE_PLANNER_SIGNATURE_SYMBOL = Symbol.for('google.adk.basePlanner');

/**
 * Type guard to check if an object is an instance of BasePlanner.
 * @param obj The object to check.
 * @returns True if the object is an instance of BasePlanner, false otherwise.
 */
export function isBasePlanner(obj: unknown): obj is BasePlanner {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_PLANNER_SIGNATURE_SYMBOL in obj &&
    obj[BASE_PLANNER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Abstract base class for all planners.
 *
 * The planner allows the agent to generate plans for the queries to guide its
 * action.
 */
export abstract class BasePlanner {
  readonly [BASE_PLANNER_SIGNATURE_SYMBOL] = true;

  /**
   * Builds the system instruction to be appended to the LLM request for
   * planning.
   *
   * @param readonlyContext The readonly context of the invocation.
   * @param llmRequest The LLM request. Readonly.
   * @returns The planning system instruction, or undefined if no instruction is
   *     needed.
   */
  abstract buildPlanningInstruction(
    readonlyContext: ReadonlyContext,
    llmRequest: LlmRequest,
  ): string | undefined;

  /**
   * Processes the LLM response for planning.
   *
   * @param callbackContext The callback context of the invocation.
   * @param responseParts The LLM response parts. Readonly.
   * @returns The processed response parts, or undefined if no processing is
   *     needed.
   */
  abstract processPlanningResponse(
    callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined;
}
