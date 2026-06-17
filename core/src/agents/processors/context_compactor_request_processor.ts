/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseContextCompactor} from '../../context/base_context_compactor.js';
import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {ContextCompactionTrigger} from '../../plugins/base_plugin.js';
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

  /**
   * @param compactors - Ordered list of compactors to evaluate; the first one
   *   that reports it should compact will perform the compaction.
   */
  constructor(compactors: BaseContextCompactor[]) {
    this.compactors = compactors;
  }

  /**
   * Evaluates compactors in priority order. The first compactor that indicates
   * it should compact will compact the session history, fire plugin hooks, and
   * yield any newly generated events. Iteration stops after one compaction.
   *
   * @param invocationContext - The current invocation context.
   * @param _llmRequest - Unused; present to satisfy the {@link BaseLlmRequestProcessor} interface.
   */
  async *runAsync(
    invocationContext: InvocationContext,
    _llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    for (const compactor of this.compactors) {
      const shouldCompact = await Promise.resolve(
        compactor.shouldCompact(invocationContext),
      );
      if (shouldCompact) {
        await invocationContext.pluginManager.runBeforeContextCompaction({
          invocationContext,
          trigger: ContextCompactionTrigger.Auto,
        });

        const oldEvents = new Set(invocationContext.session.events);
        await Promise.resolve(compactor.compact(invocationContext));

        await invocationContext.pluginManager.runAfterContextCompaction({
          invocationContext,
          trigger: ContextCompactionTrigger.Auto,
        });

        const newEvents = invocationContext.session.events.filter(
          (e) => !oldEvents.has(e),
        );
        for (const e of newEvents) {
          yield e;
        }
        return; // Stop after one compactor has compacted the history.
      }
    }
  }
}
