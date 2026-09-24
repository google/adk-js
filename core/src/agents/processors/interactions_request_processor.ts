/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {isGemini} from '../../models/google_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {logger} from '../../utils/logger.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Request processor for Gemini Interactions API.
 * Resolves the previous interaction ID from the session history and copies
 * `RunConfig.serviceTier` onto the `LlmRequest`.
 */
export class InteractionsRequestProcessor implements BaseLlmRequestProcessor {
  private lastTierWarningInvocationId?: string;

  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!agent || !isLlmAgent(agent)) {
      this.warnIfServiceTierUnusable(invocationContext);
      return;
    }

    const model = agent.canonicalModel;
    if (!isGemini(model) || !model.useInteractionsApi) {
      this.warnIfServiceTierUnusable(invocationContext);
      return;
    }

    const runConfig = invocationContext.runConfig;
    if (runConfig?.serviceTier) {
      llmRequest.serviceTier = runConfig.serviceTier;
      logger.debug(
        `Using serviceTier from runConfig: ${runConfig.serviceTier}`,
      );
    }

    const events = invocationContext.session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      // Skip events not belonging to the current branch or author
      if (
        event.branch === invocationContext.branch &&
        event.author === agent.name &&
        event.interactionId
      ) {
        llmRequest.previousInteractionId = event.interactionId;
        break;
      }
    }
  }

  /**
   * Warn that this agent's model calls will ignore the run's service tier.
   *
   * Only the interactions path carries a serving tier, so a tier set on the
   * run does nothing for an agent that does not use it. Fires once per
   * invocation ID to avoid repeating on every model turn.
   */
  private warnIfServiceTierUnusable(
    invocationContext: InvocationContext,
  ): void {
    const runConfig = invocationContext.runConfig;
    if (!runConfig?.serviceTier) {
      return;
    }
    if (this.lastTierWarningInvocationId === invocationContext.invocationId) {
      return;
    }
    this.lastTierWarningInvocationId = invocationContext.invocationId;
    logger.warn(
      `runConfig.serviceTier=${JSON.stringify(runConfig.serviceTier)} has no effect for agent ${invocationContext.agent?.name}: its model does not use the interactions API, which is the only path with a serving tier. Set useInteractionsApi=true on the model to apply the tier.`,
    );
  }
}

export const INTERACTIONS_REQUEST_PROCESSOR =
  new InteractionsRequestProcessor();
