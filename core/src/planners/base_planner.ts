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
 * Abstract base class for all planners.
 *
 * The planner allows the agent to generate plans for the queries to guide its
 * action.
 */
export abstract class BasePlanner {
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
