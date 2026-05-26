/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {InvocationContext} from '../invocation_context.js';

/**
 * Base class for LLM request processors. Implementations mutate or augment
 * the {@link LlmRequest} before it is sent to the model.
 */
export abstract class BaseLlmRequestProcessor {
  /**
   * Runs the processor, optionally yielding intermediate {@link Event}s.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request object to populate or mutate in place.
   */
  abstract runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void>;
}

/**
 * Base class for LLM response processors. Implementations inspect or
 * transform the {@link LlmResponse} after it is received from the model.
 */
export abstract class BaseLlmResponseProcessor {
  /**
   * Runs the processor, optionally yielding intermediate {@link Event}s.
   *
   * @param invocationContext - The current invocation context.
   * @param llmResponse - The response received from the model.
   */
  abstract runAsync(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void>;
}
