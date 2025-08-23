/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';

/**
 * Base class for LLM request processor.
 */
export abstract class BaseLlmRequestProcessor {
  /**
   * Runs the processor.
   */
  abstract runAsync(
      invocationContext: InvocationContext,
      llmRequest: LlmRequest): AsyncGenerator<Event, void, void>;
}

/**
 * Base class for LLM response processor.
 */
export abstract class BaseLlmResponseProcessor {
  /**
   * Processes the LLM response.
   */
  abstract runAsync(
      invocationContext: InvocationContext,
      llmResponse: LlmResponse): AsyncGenerator<Event, void, void>;
}