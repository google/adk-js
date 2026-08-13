/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {LlmRequest, appendInstructions} from '../../models/llm_request.js';
import {InvocationContext, requireAgent} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Appends identity instructions to the {@link LlmRequest} system prompt,
 * informing the model of the agent's name and description.
 *
 * The instructions are omitted for an agent that cannot transfer control
 * anywhere, since nothing in the prompt consumes the identity in that case.
 */
export class IdentityLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Appends agent name and description as identity instructions to the system
   * prompt of the request, unless the agent has no reachable transfer target.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request object to append instructions to.
   */
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, undefined> {
    const agent = requireAgent(invocationContext);
    // The preamble only exists so the model can name itself when handing off
    // control, and embedding the agent name gives every sibling of a fan-out a
    // distinct system prompt, which defeats prompt-prefix caching on local
    // models (google/adk-js#613). Mirrors the condition in the LlmAgent
    // constructor that decides whether the transfer processor runs at all.
    if (
      isLlmAgent(agent) &&
      agent.disallowTransferToParent &&
      agent.disallowTransferToPeers &&
      agent.subAgents.length === 0
    ) {
      return;
    }
    const si = [`You are an agent. Your internal name is "${agent.name}".`];
    if (agent.description) {
      si.push(`The description about you is "${agent.description}"`);
    }
    appendInstructions(llmRequest, si);
  }
}

export const IDENTITY_LLM_REQUEST_PROCESSOR = new IdentityLlmRequestProcessor();
