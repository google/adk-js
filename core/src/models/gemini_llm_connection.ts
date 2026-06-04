/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Blob,
  Content,
  FunctionResponse,
  GroundingMetadata,
  LiveServerMessage,
  Part,
  Session,
} from '@google/genai';

import {logger} from '../utils/logger.js';
import {isGemini3xFlashLive} from '../utils/model_name.js';

import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmResponse} from './llm_response.js';

/** The Gemini model connection. */
export class GeminiLlmConnection implements BaseLlmConnection {
  private _inputTranscriptionText = '';
  private _outputTranscriptionText = '';

  constructor(
    private readonly geminiSession: Session,
    private readonly modelVersion?: string,
    private readonly messageQueue?: AsyncIterable<LiveServerMessage>,
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
      const isGemini3x = isGemini3xFlashLive(this.modelVersion);
      this.geminiSession.sendClientContent({
        turns: contents,
        turnComplete: isGemini3x
          ? true
          : contents[contents.length - 1].role === 'user',
      });
    } else {
      logger.info('no content is sent');
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
      const functionResponses = content.parts
        .map((part) => part.functionResponse)
        .filter((fr): fr is FunctionResponse => !!fr);
      logger.debug('Sending LLM function response:', functionResponses);
      this.geminiSession.sendToolResponse({
        functionResponses,
      });
    } else {
      logger.debug('Sending LLM new content', content);
      const isGemini3x = isGemini3xFlashLive(this.modelVersion);
      if (isGemini3x && content.parts.length === 1 && content.parts[0].text) {
        logger.debug('Using sendRealtimeInput for Gemini 3.x text input');
        this.geminiSession.sendRealtimeInput({text: content.parts[0].text});
      } else {
        this.geminiSession.sendClientContent({
          turns: [content],
          turnComplete: true,
        });
      }
    }
  }

  /**
   * Sends a chunk of audio or a frame of video to the model in realtime.
   *
   * @param blob The blob to send to the model.
   */
  async sendRealtime(blob: Blob): Promise<void> {
    logger.debug('Sending LLM Blob:', blob);
    const isGemini3x = isGemini3xFlashLive(this.modelVersion);
    const isNativeAudio = this.modelVersion?.includes('native-audio');

    if (isGemini3x || isNativeAudio) {
      if (blob.mimeType?.startsWith('audio/')) {
        this.geminiSession.sendRealtimeInput({audio: blob});
      } else if (blob.mimeType?.startsWith('image/')) {
        this.geminiSession.sendRealtimeInput({video: blob});
      } else {
        logger.warn(
          'Blob not sent. Unknown or empty mime type for sendRealtimeInput:',
          blob.mimeType,
        );
      }
    } else {
      this.geminiSession.sendRealtimeInput({media: blob});
    }
  }

  /**
   * Builds a full text response.
   *
   * The text should not be partial and the returned LlmResponse is not be
   * partial.
   *
   * @param text The text to be included in the response.
   * @param isThought Whether the text is a thought.
   * @param groundingMetadata The grounding metadata to include.
   * @returns An LlmResponse containing the full text.
   */
  private buildFullTextResponse(
    text: string,
    isThought = false,
    groundingMetadata?: GroundingMetadata,
  ): LlmResponse {
    const part: Part = {text};
    if (isThought) {
      part.thought = true;
    }
    const response: LlmResponse = {
      content: {
        role: 'model',
        parts: [part],
      },
      partial: false,
    };
    if (groundingMetadata !== undefined && groundingMetadata !== null) {
      response.groundingMetadata = groundingMetadata;
    }
    if (this.modelVersion) {
      response.modelVersion = this.modelVersion;
    }
    return response;
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    if (!this.messageQueue) {
      throw new Error('Message queue is not initialized.');
    }

    let text = '';
    let isThought = false;
    let toolCallParts: Part[] = [];
    let pendingGroundingMetadata: GroundingMetadata | undefined = undefined;

    for await (const message of this.messageQueue) {
      logger.debug('Got LLM Live message:', message);

      if (message.usageMetadata) {
        yield {
          usageMetadata: message.usageMetadata,
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };
      }

      if (message.serverContent) {
        const serverContent = message.serverContent;
        const content = serverContent.modelTurn;

        if (serverContent.groundingMetadata) {
          pendingGroundingMetadata = serverContent.groundingMetadata;
        }

        // Standalone groundingMetadata event (when content is empty)
        if (
          !(content && content.parts) &&
          serverContent.groundingMetadata &&
          !serverContent.turnComplete
        ) {
          yield {
            groundingMetadata: serverContent.groundingMetadata,
            ...(serverContent.interrupted !== undefined
              ? {interrupted: serverContent.interrupted}
              : {}),
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
        }

        if (content && content.parts) {
          const llmResponse: LlmResponse = {
            content: content as Content,
            ...(serverContent.interrupted !== undefined
              ? {interrupted: serverContent.interrupted}
              : {}),
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };

          if (!serverContent.turnComplete && serverContent.groundingMetadata) {
            llmResponse.groundingMetadata = serverContent.groundingMetadata;
          }

          const hasInlineData = content.parts.some((p) => p.inlineData);
          for (const part of content.parts) {
            if (part.text) {
              const currentIsThought = !!part.thought;
              if (text && currentIsThought !== isThought) {
                yield this.buildFullTextResponse(text, isThought);
                text = '';
                isThought = false;
              }
              text += part.text;
              isThought = currentIsThought;
              llmResponse.partial = true;
            }
          }

          // don't yield the merged text event when receiving audio data
          if (text && !content.parts.some((p) => p.text) && !hasInlineData) {
            yield this.buildFullTextResponse(text, isThought);
            text = '';
            isThought = false;
          }

          yield llmResponse;
        }

        if (serverContent.inputTranscription) {
          if (serverContent.inputTranscription.text) {
            this._inputTranscriptionText +=
              serverContent.inputTranscription.text;
            yield {
              inputTranscription: {
                text: serverContent.inputTranscription.text,
                finished: false,
              },
              partial: true,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
          }
          if (serverContent.inputTranscription.finished) {
            yield {
              inputTranscription: {
                text: this._inputTranscriptionText,
                finished: true,
              },
              partial: false,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
            this._inputTranscriptionText = '';
          }
        }

        if (serverContent.outputTranscription) {
          if (serverContent.outputTranscription.text) {
            this._outputTranscriptionText +=
              serverContent.outputTranscription.text;
            yield {
              outputTranscription: {
                text: serverContent.outputTranscription.text,
                finished: false,
              },
              partial: true,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
          }
          if (serverContent.outputTranscription.finished) {
            yield {
              outputTranscription: {
                text: this._outputTranscriptionText,
                finished: true,
              },
              partial: false,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
            this._outputTranscriptionText = '';
          }
        }

        if (
          serverContent.interrupted ||
          serverContent.turnComplete ||
          serverContent.generationComplete
        ) {
          if (this._inputTranscriptionText) {
            yield {
              inputTranscription: {
                text: this._inputTranscriptionText,
                finished: true,
              },
              partial: false,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
            this._inputTranscriptionText = '';
          }
          if (this._outputTranscriptionText) {
            yield {
              outputTranscription: {
                text: this._outputTranscriptionText,
                finished: true,
              },
              partial: false,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
            this._outputTranscriptionText = '';
          }
        }

        if (serverContent.turnComplete) {
          let gMetadataToYield = pendingGroundingMetadata;
          if (text) {
            yield this.buildFullTextResponse(text, isThought, gMetadataToYield);
            text = '';
            isThought = false;
            gMetadataToYield = undefined;
          }
          if (toolCallParts.length > 0) {
            logger.debug('Returning aggregated toolCallParts');
            yield {
              content: {role: 'model', parts: toolCallParts},
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
            toolCallParts = [];
          }
          const finalResponse: LlmResponse = {
            turnComplete: true,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          if (serverContent.interrupted !== undefined) {
            finalResponse.interrupted = serverContent.interrupted;
          }
          const finalGrounding =
            serverContent.groundingMetadata || gMetadataToYield;
          if (finalGrounding !== undefined && finalGrounding !== null) {
            finalResponse.groundingMetadata = finalGrounding;
          }
          yield finalResponse;
          break;
        }

        if (serverContent.interrupted) {
          if (text) {
            yield this.buildFullTextResponse(text, isThought);
            text = '';
            isThought = false;
          } else {
            yield {
              interrupted: serverContent.interrupted,
              ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
            };
          }
        }
      }

      if (message.toolCall) {
        logger.debug('Received tool call:', message.toolCall);
        if (text) {
          yield this.buildFullTextResponse(text, isThought);
          text = '';
          isThought = false;
        }
        if (message.toolCall.functionCalls) {
          toolCallParts.push(
            ...message.toolCall.functionCalls.map((fc) => ({
              functionCall: fc,
            })),
          );
        }

        const isGemini3x = isGemini3xFlashLive(this.modelVersion);
        if (isGemini3x && toolCallParts.length > 0) {
          logger.debug(
            'Yielding toolCallParts immediately for Gemini 3.x live tool call',
          );
          yield {
            content: {role: 'model', parts: toolCallParts},
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          toolCallParts = [];
        }
      }

      if (message.sessionResumptionUpdate) {
        logger.debug('Received session resumption message:', message);
        yield {
          liveSessionResumptionUpdate: message.sessionResumptionUpdate,
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };
      }

      if (message.goAway) {
        logger.debug('Received GoAway message:', message.goAway);
        yield {
          goAway: message.goAway,
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };
      }
    }

    if (toolCallParts.length > 0) {
      logger.debug('Exited loop with pending toolCallParts');
      yield {
        content: {role: 'model', parts: toolCallParts},
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }
  }

  /**
   * Closes the llm server connection.
   */
  async close(): Promise<void> {
    this.geminiSession.close();
  }
}
