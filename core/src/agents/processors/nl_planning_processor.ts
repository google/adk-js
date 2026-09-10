/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../../events/event.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {BasePlanner, isBasePlanner} from '../../planners/base_planner.js';
import {
  BuiltInPlanner,
  isBuiltInPlanner,
} from '../../planners/built_in_planner.js';
import {
  isPlanReActPlanner,
  PlanReActPlanner,
} from '../../planners/plan_re_act_planner.js';
import {Context} from '../context.js';
import {InvocationContext, requireAgent} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './base_llm_processor.js';

/**
 * Request processor that applies the agent's planner before the model call.
 */
export class NlPlanningRequestProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield -- BaseLlmRequestProcessor mandates an AsyncGenerator, but this processor only mutates the request and has no event to emit
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const planner = getPlanner(invocationContext);
    if (!planner) {
      return;
    }

    if (isBuiltInPlanner(planner)) {
      planner.applyThinkingConfig(llmRequest);
    } else if (isPlanReActPlanner(planner)) {
      const planningInstruction = planner.buildPlanningInstruction(
        new ReadonlyContext(invocationContext),
        llmRequest,
      );
      if (planningInstruction) {
        appendInstructions(llmRequest, [planningInstruction]);
      }
      removeThoughtFromRequest(llmRequest);
    }
  }
}

export const NL_PLANNING_REQUEST_PROCESSOR = new NlPlanningRequestProcessor();

/**
 * Response processor that lets the agent's planner post-process the model
 * response parts.
 */
export class NlPlanningResponseProcessor extends BaseLlmResponseProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    if (!llmResponse || !llmResponse.content || !llmResponse.content.parts) {
      return;
    }

    const planner = getPlanner(invocationContext);
    // This asks whether the planner overrode the hook, not what type it is, so
    // a BuiltInPlanner subclass that implements it still runs.
    if (
      !planner ||
      planner.processPlanningResponse ===
        BuiltInPlanner.prototype.processPlanningResponse
    ) {
      return;
    }

    // Postprocess the LLM response.
    const callbackContext = new Context({invocationContext});
    const processedParts = planner.processPlanningResponse(
      callbackContext,
      llmResponse.content.parts,
    );
    if (processedParts) {
      llmResponse.content.parts = processedParts;
    }

    if (callbackContext.state.hasDelta()) {
      yield createEvent({
        invocationId: invocationContext.invocationId,
        author: requireAgent(invocationContext).name,
        branch: invocationContext.branch,
        actions: callbackContext.eventActions,
      });
    }
  }
}

export const NL_PLANNING_RESPONSE_PROCESSOR = new NlPlanningResponseProcessor();

/**
 * Resolves the planner configured on the running agent.
 *
 * @param invocationContext The current invocation context.
 * @returns The agent's planner, or undefined when the agent has none.
 */
function getPlanner(
  invocationContext: InvocationContext,
): BasePlanner | undefined {
  const agent = invocationContext.agent;
  if (!isLlmAgent(agent)) {
    return undefined;
  }
  if (!agent.planner) {
    return undefined;
  }
  if (isBasePlanner(agent.planner)) {
    return agent.planner;
  }
  return new PlanReActPlanner();
}

/**
 * Clears the `thought` flag from every content part of the request.
 *
 * @param llmRequest The LLM request to strip thought flags from.
 */
function removeThoughtFromRequest(llmRequest: LlmRequest): void {
  if (!llmRequest.contents) {
    return;
  }
  for (const content of llmRequest.contents) {
    for (const part of content.parts ?? []) {
      part.thought = undefined;
    }
  }
}
