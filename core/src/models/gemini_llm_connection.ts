/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob, Content, FunctionResponse, Session,} from '@google/genai';

import {getLogger} from '../utils/logger.js';

import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmResponse} from './llm_response.js';

/** The Gemini model connection. */
export class GeminiLlmConnection implements BaseLlmConnection {
  private readonly logger = getLogger();

  constructor(
      private readonly geminiSession: Session,
  ) {}

  /**
   * Sends the conversation history to the gemini model.
   *
   * You call this method right after setting up the model connection.
   * The model will respond if the last content is from user, otherwise it will
   * wait for new user input before responding.
   *
   * @param history The conversation history to send to the model.
   */
  async sendHistory(history: Content[]): Promise<void> {
    // We ignore any audio from user during the agent transfer phase.
    const contents = history.filter(
        (content) => content.parts && content.parts[0]?.text,
    );

    if (contents.length > 0) {
      this.geminiSession.sendClientContent({
        turns: contents,
        turnComplete: contents[contents.length - 1].role === 'user',
      });
    } else {
      this.logger.info('no content is sent');
    }
  }

  /**
   * Sends a user content to the gemini model.
   *
   * The model will respond immediately upon receiving the content.
   * If you send function responses, all parts in the content should be function
   * responses.
   *
   * @param content The content to send to the model.
   */
  async sendContent(content: Content): Promise<void> {
    if (!content.parts) {
      throw new Error('Content must have parts.');
    }
    if (content.parts[0].functionResponse) {
      // All parts have to be function responses.
      const functionResponses =
          content.parts.map((part) => part.functionResponse)
              .filter((fr): fr is FunctionResponse => !!fr);
      this.logger.debug('Sending LLM function response:', functionResponses);
      this.geminiSession.sendToolResponse({
        functionResponses,
      });
    } else {
      this.logger.debug('Sending LLM new content', content);
      this.geminiSession.sendClientContent({
        turns: [content],
        turnComplete: true,
      });
    }
  }

  /**
   * Sends a chunk of audio or a frame of video to the model in realtime.
   *
   * @param blob The blob to send to the model.
   */
  async sendRealtime(blob: Blob): Promise<void> {
    this.logger.debug('Sending LLM Blob:', blob);
    this.geminiSession.sendRealtimeInput({media: blob});
  }

  /**
   * Builds a full text response.
   *
   * The text should not be partial and the returned LlmResponse is not be
   * partial.
   *
   * @param text The text to be included in the response.
   * @returns An LlmResponse containing the full text.
   */
  private buildFullTextResponse(text: string): LlmResponse {
    return {
      content: {
        role: 'model',
        parts: [{text}],
      },
    };
  }

  // TODO(b/425992518): GenAI SDK inconsistent API, missing methods.
  async * receive(): AsyncGenerator<LlmResponse, void, void> {
    throw new Error('Not Implemented.');
  }

  /**
   * Closes the llm server connection.
   */
  async close(): Promise<void> {
    this.geminiSession.close();
  }
}
