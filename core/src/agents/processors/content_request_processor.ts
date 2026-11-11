/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getActiveEvents} from '../../context/compaction_utils.js';
import {Event} from '../../events/event.js';
import {BaseLlm, isBaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {BaseAgent} from '../base_agent.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent, LlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';
import {
  getContents,
  getCurrentTurnContents,
} from './content_processor_utils.js';

const CLAUDE_MODEL_SYMBOL = Symbol.for('google.adk.claudeModel');
const CLAUDE_MODEL_NAME_PATTERN = /^claude-/i;

function isClaudeModelInstance(model: BaseLlm): boolean {
  return (
    (CLAUDE_MODEL_SYMBOL in model && model[CLAUDE_MODEL_SYMBOL] === true) ||
    CLAUDE_MODEL_NAME_PATTERN.test(model.model)
  );
}

function shouldPreserveFunctionCallIds(
  agent: LlmAgent,
  llmRequest: LlmRequest,
): boolean {
  if (llmRequest.model && CLAUDE_MODEL_NAME_PATTERN.test(llmRequest.model)) {
    return true;
  }

  let current: BaseAgent | undefined = agent;
  while (current) {
    if (isLlmAgent(current)) {
      if (isBaseLlm(current.model)) {
        return isClaudeModelInstance(current.model);
      }
      if (typeof current.model === 'string' && current.model.length > 0) {
        return CLAUDE_MODEL_NAME_PATTERN.test(current.model);
      }
    }
    current = current.parentAgent;
  }

  return false;
}

/**
 * Populates {@link LlmRequest.contents} from the session event history.
 *
 * When a {@link CompactedEvent} exists in the session, only the most recent
 * compacted event and the raw events that follow it are included, eliding
 * earlier history. The extent of context included depends on the agent's
 * `includeContents` setting: `'default'` sends the full visible history while
 * any other value sends only the current-turn context.
 */
export class ContentRequestProcessor implements BaseLlmRequestProcessor {
  /**
   * Fills {@link LlmRequest.contents} based on the session event history and
   * agent configuration.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request whose contents field will be populated.
   */
  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!agent || !isLlmAgent(agent)) {
      return;
    }

    const events = getActiveEvents(
      invocationContext.session.events,
      invocationContext.isolationScope,
    );
    const preserveFunctionCallIds = shouldPreserveFunctionCallIds(
      agent,
      llmRequest,
    );

    if (agent.includeContents === 'default') {
      // Include full conversation history
      llmRequest.contents = getContents(
        events,
        agent.name,
        invocationContext.branch,
        invocationContext.isolationScope,
        preserveFunctionCallIds,
      );
    } else {
      // Include current turn context only (no conversation history).
      llmRequest.contents = getCurrentTurnContents(
        events,
        agent.name,
        invocationContext.branch,
        invocationContext.isolationScope,
        preserveFunctionCallIds,
      );
    }

    return;
  }
}

export const CONTENT_REQUEST_PROCESSOR = new ContentRequestProcessor();
