/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {LlmRequest, setOutputSchema} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

export class BasicLlmRequestProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }

    // set model string, not model instance.
    llmRequest.model = agent.canonicalModel.model;

    llmRequest.config = {...(agent.generateContentConfig ?? {})};
    if (agent.outputSchema) {
      setOutputSchema(llmRequest, agent.outputSchema);
    }

    if (invocationContext.runConfig) {
      llmRequest.liveConnectConfig.responseModalities =
        invocationContext.runConfig.responseModalities;
      llmRequest.liveConnectConfig.speechConfig =
        invocationContext.runConfig.speechConfig;
      llmRequest.liveConnectConfig.outputAudioTranscription =
        invocationContext.runConfig.outputAudioTranscription;
      llmRequest.liveConnectConfig.inputAudioTranscription =
        invocationContext.runConfig.inputAudioTranscription;
      llmRequest.liveConnectConfig.realtimeInputConfig =
        invocationContext.runConfig.realtimeInputConfig;
      llmRequest.liveConnectConfig.enableAffectiveDialog =
        invocationContext.runConfig.enableAffectiveDialog;
      llmRequest.liveConnectConfig.proactivity =
        invocationContext.runConfig.proactivity;
    }
  }
}

export const BASIC_LLM_REQUEST_PROCESSOR = new BasicLlmRequestProcessor();
