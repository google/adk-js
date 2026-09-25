/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';

import {Event} from '../../events/event.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {BasePlanner, isBasePlanner} from '../../planners/base_planner.js';
import {isBuiltInPlanner} from '../../planners/built_in_planner.js';
import {Context} from '../context.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './base_llm_processor.js';

/**
 * Returns the planner of the invocation's agent, or undefined when the agent
 * is not an LlmAgent or has no planner.
 */
function getPlanner(
  invocationContext: InvocationContext,
): BasePlanner | undefined {
  const agent = invocationContext.agent;
  if (!isLlmAgent(agent) || !isBasePlanner(agent.planner)) {
    return undefined;
  }
  return agent.planner;
}

/**
 * Returns a copy of `part` without the `thought` flag.
 */
function removeThought(part: Part): Part {
  const {thought: _thought, ...rest} = part;
  return rest;
}

/**
 * Returns copies of `contents` whose parts carry no `thought` flag.
 *
 * The request contents can share part objects with the session's stored
 * events, so the parts are copied rather than changed in place.
 */
function removeThoughtFromContents(contents: Content[]): Content[] {
  return contents.map((content) =>
    content.parts
      ? {...content, parts: content.parts.map(removeThought)}
      : content,
  );
}

/**
 * Prepares the LLM request for the agent's planner.
 *
 * Applies a `BuiltInPlanner`'s thinking config, appends the planner's
 * planning instruction, and clears the `thought` flag on every request part
 * so that earlier planning output goes back to the model as plain text.
 */
export class NlPlanningRequestProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield -- this processor only mutates the request and has no event to emit
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
    }

    const planningInstruction = planner.buildPlanningInstruction(
      new ReadonlyContext(invocationContext),
      llmRequest,
    );
    if (planningInstruction) {
      appendInstructions(llmRequest, [planningInstruction]);
    }

    llmRequest.contents = removeThoughtFromContents(llmRequest.contents);
  }
}

/**
 * Replaces the LLM response parts with the planner's processed parts.
 *
 * Partial responses are processed too.
 */
export class NlPlanningResponseProcessor extends BaseLlmResponseProcessor {
  // eslint-disable-next-line require-yield -- this processor only rewrites the response and has no event to emit
  override async *runAsync(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    const planner = getPlanner(invocationContext);
    if (!planner || !llmResponse.content?.parts?.length) {
      return;
    }

    const processedParts = planner.processPlanningResponse(
      new Context({invocationContext}),
      llmResponse.content.parts,
    );
    if (processedParts !== undefined) {
      llmResponse.content = {...llmResponse.content, parts: processedParts};
    }
  }
}

export const NL_PLANNING_REQUEST_PROCESSOR = new NlPlanningRequestProcessor();

export const NL_PLANNING_RESPONSE_PROCESSOR = new NlPlanningResponseProcessor();
