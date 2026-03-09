/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {
  getContents,
  getCurrentTurnContents,
} from '../content_processor_utils.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

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

    if (agent.includeContents === 'default') {
      // Include full conversation history
      llmRequest.contents = getContents(
        invocationContext.session.events,
        agent.name,
        invocationContext.branch,
      );
    } else {
      // Include current turn context only (no conversation history).
      llmRequest.contents = getCurrentTurnContents(
        invocationContext.session.events,
        agent.name,
        invocationContext.branch,
      );
    }

    return;
  }
}

export const CONTENT_REQUEST_PROCESSOR = new ContentRequestProcessor();
