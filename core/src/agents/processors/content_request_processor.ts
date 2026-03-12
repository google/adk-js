/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isCompactedEvent} from '../../events/compacted_event.js';
import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';
import {
  getContents,
  getCurrentTurnContents,
} from './content_processor_utils.js';

export class ContentRequestProcessor implements BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!agent || !isLlmAgent(agent)) {
      return;
    }

    // The assumption is there's one CompactedEvent considered in any given call to the LLM
    // since it should be a summary of all previous event history.
    let events = invocationContext.session.events;
    const compactedEvents = events.filter(isCompactedEvent);
    const latestCompactedEvent =
      compactedEvents.length > 0
        ? compactedEvents.reduce((latest, current) =>
            current.endTime > latest.endTime ? current : latest,
          )
        : undefined;

    if (latestCompactedEvent) {
      const remainingEvents = events.filter((event) => {
        if (event === latestCompactedEvent) {
          return false;
        }
        // Elide all previous compacted events as they are overridden
        if (isCompactedEvent(event)) {
          return false;
        }
        // Elide raw events covered by the compacted event
        if (event.timestamp <= latestCompactedEvent.endTime) {
          return false;
        }
        return true;
      });
      events = [latestCompactedEvent, ...remainingEvents];
    }

    if (agent.includeContents === 'default') {
      // Include full conversation history
      llmRequest.contents = getContents(
        events,
        agent.name,
        invocationContext.branch,
      );
    } else {
      // Include current turn context only (no conversation history).
      llmRequest.contents = getCurrentTurnContents(
        events,
        agent.name,
        invocationContext.branch,
      );
    }

    return;
  }
}

export const CONTENT_REQUEST_PROCESSOR = new ContentRequestProcessor();
