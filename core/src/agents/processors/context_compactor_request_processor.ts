/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseContextCompactor} from '../../context/base_context_compactor.js';
import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * A processor that evaluates a set of compactors to optionally compact
 * the conversation history (events) prior to generating an LLM request.
 *
 * It evaluates each compactor in priority order. The first one that indicates
 * it should compact will perform the compaction and iteration stops.
 */
export class ContextCompactorRequestProcessor implements BaseLlmRequestProcessor {
  private compactors: BaseContextCompactor[];

  constructor(compactors: BaseContextCompactor[]) {
    this.compactors = compactors;
  }

  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    _llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    for (const compactor of this.compactors) {
      const shouldCompact = await Promise.resolve(
        compactor.shouldCompact(invocationContext),
      );
      if (shouldCompact) {
        await Promise.resolve(compactor.compact(invocationContext));
        break; // Stop after one compactor has compacted the history.
      }
    }
  }
}
