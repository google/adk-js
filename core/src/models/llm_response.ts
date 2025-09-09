/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FinishReason, GenerateContentResponse, GenerateContentResponseUsageMetadata, GroundingMetadata, LiveServerSessionResumptionUpdate, Transcription,} from '@google/genai';

/**
 * LLM response class that provides the first candidate response from the
 * model if available. Otherwise, returns error code and message.
 */
export interface LlmResponse {
  /**
   * The content of the response.
   */
  content?: Content;

  /**
   * The grounding metadata of the response.
   */
  groundingMetadata?: GroundingMetadata;

  /**
   * Indicates whether the text content is part of a unfinished text stream.
   * Only used for streaming mode and when the content is plain text.
   */
  partial?: boolean;

  /**
   * Indicates whether the response from the model is complete.
   * Only used for streaming mode.
   */
  turnComplete?: boolean;

  /**
   * Error code if the response is an error. Code varies by model.
   */
  errorCode?: string;

  /**
   * Error message if the response is an error.
   */
  errorMessage?: string;

  /**
   * Flag indicating that LLM was interrupted when generating the content.
   * Usually it's due to user interruption during a bidi streaming.
   */
  interrupted?: boolean;

  /**
   * The custom metadata of the LlmResponse.
   * An optional key-value pair to label an LlmResponse.
   * NOTE: the entire object must be JSON serializable.
   */
  customMetadata?: {[key: string]: any};

  /**
   * The usage metadata of the LlmResponse.
   */
  usageMetadata?: GenerateContentResponseUsageMetadata;

  /**
   * The finish reason of the response.
   */
  finishReason?: FinishReason;

  /**
   * The session resumption update of the LlmResponse
   */
  liveSessionResumptionUpdate?: LiveServerSessionResumptionUpdate;

  /**
   * Audio transcription of user input.
   */
  inputTranscription?: Transcription;

  /**
   * Audio transcription of model output.
   */
  outputTranscription?: Transcription;
}

/**
 * Creates an LlmResponse from a GenerateContentResponse.
 *
 * @param response The GenerateContentResponse to create the
 *   LlmResponse from.
 * @returns The LlmResponse.
 */
export function createLlmResponse(
    response: GenerateContentResponse,
    ): LlmResponse {
  const usageMetadata = response.usageMetadata;

  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];
    if (candidate.content?.parts && candidate.content.parts.length > 0) {
      return {
        content: candidate.content,
        groundingMetadata: candidate.groundingMetadata,
        usageMetadata: usageMetadata,
        finishReason: candidate.finishReason,
      };
    }

    return {
      errorCode: candidate.finishReason,
      errorMessage: candidate.finishMessage,
      usageMetadata: usageMetadata,
      finishReason: candidate.finishReason,
    };
  }

  if (response.promptFeedback) {
    return {
      errorCode: response.promptFeedback.blockReason,
      errorMessage: response.promptFeedback.blockReasonMessage,
      usageMetadata: usageMetadata,
    };
  }

  // The ultimate fallback for an unknown error state
  return {
    errorCode: 'UNKNOWN_ERROR',
    errorMessage: 'Unknown error.',
    usageMetadata: usageMetadata,
  };
}
