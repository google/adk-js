/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {LlmRequest, appendInstructions} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

export class IdentityLlmRequestProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, undefined> {
    const agent = invocationContext.agent;
    const si = [`You are an agent. Your internal name is "${agent.name}".`];
    if (agent.description) {
      si.push(`The description about you is "${agent.description}"`);
    }
    appendInstructions(llmRequest, si);
  }
}

export const IDENTITY_LLM_REQUEST_PROCESSOR = new IdentityLlmRequestProcessor();
