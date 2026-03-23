/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {injectSessionState} from '../instructions.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

export class InstructionsLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Handles instructions and global instructions for LLM flow.
   */
  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }
    const rootAgent = agent.rootAgent;
    // TODO - b/425992518: unexpected and buggy for performance.
    // Global instruction should be explicitly scoped.
    // Step 1: Appends global instructions if set by RootAgent.
    if (isLlmAgent(rootAgent) && rootAgent.globalInstruction) {
      const {instruction, requireStateInjection} =
        await rootAgent.canonicalGlobalInstruction(
          new ReadonlyContext(invocationContext),
        );
      let instructionWithState = instruction;
      if (requireStateInjection) {
        instructionWithState = await injectSessionState(
          instruction,
          new ReadonlyContext(invocationContext),
        );
      }
      appendInstructions(llmRequest, [instructionWithState]);
    }

    // Step 2: Appends agent local instructions if set.
    // TODO - b/425992518: requireStateInjection means user passed a
    // instruction processor. We need to make it more explicit.
    if (agent.instruction) {
      const {instruction, requireStateInjection} =
        await agent.canonicalInstruction(
          new ReadonlyContext(invocationContext),
        );
      let instructionWithState = instruction;
      if (requireStateInjection) {
        instructionWithState = await injectSessionState(
          instruction,
          new ReadonlyContext(invocationContext),
        );
      }
      appendInstructions(llmRequest, [instructionWithState]);
    }
  }
}

export const INSTRUCTIONS_LLM_REQUEST_PROCESSOR =
  new InstructionsLlmRequestProcessor();
