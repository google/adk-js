/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * The BaseLLM class.
 */
export abstract class BaseLlm {
  /**
   * Creates an instance of BaseLLM.
   *
   * @param model The name of the LLM, e.g. gemini-1.5-flash or
   *     gemini-1.5-flash-001.
   */
  constructor(readonly model: string) {}

  /**
   * List of supported models in regex for LlmRegistry.
   */
  static readonly supportedModels: Array<string|RegExp> = [];

  /**
   * Generates one content from the given contents and tools.
   *
   * @param llmRequest  LlmRequest, the request to send to the LLM.
   * @param stream whether to do streaming call.
   * For non-streaming call, it will only yield one Content.
   * @return A generator of LlmResponse.
   */
  abstract generateContentAsync(llmRequest: LlmRequest, stream?: boolean):
      AsyncGenerator<LlmResponse, void>;

  /**
   * Creates a live connection to the LLM.
   *
   * @param llmRequest LlmRequest, the request to send to the LLM.
   * @return A live connection to the LLM.
   */
  abstract connect(llmRequest: LlmRequest): Promise<BaseLlmConnection>;

  /**
   * Appends a user content, so that model can continue to output.
   *
   * @param llmRequest LlmRequest, the request to send to the LLM.
   */
  maybeAppendUserContent(llmRequest: LlmRequest): void {
    if (llmRequest.contents.length === 0) {
      llmRequest.contents.push({
        role: 'user',
        parts: [
          {text: 'Handle the requests as specified in the System Instruction.'}
        ],
      });
    }

    if (llmRequest.contents[llmRequest.contents.length - 1]?.role !== 'user') {
      llmRequest.contents.push({
        role: 'user',
        parts: [{
          text:
              'Continue processing previous requests as instructed. Exit or provide a summary if no more outputs are needed.'
        }],
      });
    }
  }
}