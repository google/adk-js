/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part, ThinkingConfig} from '@google/genai';

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';

import {BasePlanner} from './base_planner.js';

/**
 * The built-in planner that uses model's built-in thinking features.
 */
export class BuiltInPlanner extends BasePlanner {
  /**
   * Config for model built-in thinking features. An error will be returned if
   * this field is set for models that don't support thinking.
   */
  thinkingConfig: ThinkingConfig;

  /**
   * Initializes the built-in planner.
   *
   * @param options.thinkingConfig Config for model built-in thinking features.
   *     An error will be returned if this field is set for models that don't
   *     support thinking.
   */
  constructor(options: {thinkingConfig: ThinkingConfig}) {
    super();
    this.thinkingConfig = options.thinkingConfig;
  }

  /**
   * Applies the thinking config to the LLM request.
   *
   * @param llmRequest The LLM request to apply the thinking config to.
   */
  applyThinkingConfig(llmRequest: LlmRequest): void {
    if (this.thinkingConfig) {
      llmRequest.config = llmRequest.config ?? {};
      llmRequest.config.thinkingConfig = this.thinkingConfig;
    }
  }

  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return undefined;
  }

  processPlanningResponse(
    _callbackContext: Context,
    _responseParts: Part[],
  ): Part[] | undefined {
    return undefined;
  }
}
