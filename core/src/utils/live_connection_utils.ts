/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  GroundingMetadata,
  LiveServerMessage,
  Part,
} from '@google/genai';
import {LlmResponse} from '../models/llm_response.js';
import {isGemini3xFlashLive} from './model_name.js';

/**
 * Aggregator and mapper for Gemini Live WebSocket server messages.
 *
 * Translates incoming raw WebSocket server messages (push stream) into unified
 * agent-consumable LlmResponse objects (pull stream), managing transcription buffers,
 * grounding metadata, text segments, and tool calls.
 */
export class LiveResponseAggregator {
  private text = '';
  private isThought = false;
  private toolCallParts: Part[] = [];
  private pendingGroundingMetadata: GroundingMetadata | undefined = undefined;
  private inputTranscriptionText = '';
  private outputTranscriptionText = '';

  constructor(private readonly modelVersion?: string) {}

  *processMessage(
    message: LiveServerMessage,
  ): Generator<LlmResponse, void, void> {
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
        this.pendingGroundingMetadata = serverContent.groundingMetadata;
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
            if (this.text && currentIsThought !== this.isThought) {
              yield this.buildFullTextResponse(this.text, this.isThought);
              this.text = '';
              this.isThought = false;
            }
            this.text += part.text;
            this.isThought = currentIsThought;
            llmResponse.partial = true;
          }
        }

        // don't yield the merged text event when receiving audio data
        if (this.text && !content.parts.some((p) => p.text) && !hasInlineData) {
          yield this.buildFullTextResponse(this.text, this.isThought);
          this.text = '';
          this.isThought = false;
        }

        yield llmResponse;
      }

      if (serverContent.inputTranscription) {
        if (serverContent.inputTranscription.text) {
          this.inputTranscriptionText += serverContent.inputTranscription.text;
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
              text: this.inputTranscriptionText,
              finished: true,
            },
            partial: false,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.inputTranscriptionText = '';
        }
      }

      if (serverContent.outputTranscription) {
        if (serverContent.outputTranscription.text) {
          this.outputTranscriptionText +=
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
              text: this.outputTranscriptionText,
              finished: true,
            },
            partial: false,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.outputTranscriptionText = '';
        }
      }

      if (
        serverContent.interrupted ||
        serverContent.turnComplete ||
        serverContent.generationComplete
      ) {
        if (this.inputTranscriptionText) {
          yield {
            inputTranscription: {
              text: this.inputTranscriptionText,
              finished: true,
            },
            partial: false,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.inputTranscriptionText = '';
        }
        if (this.outputTranscriptionText) {
          yield {
            outputTranscription: {
              text: this.outputTranscriptionText,
              finished: true,
            },
            partial: false,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.outputTranscriptionText = '';
        }
      }

      if (serverContent.turnComplete) {
        let gMetadataToYield = this.pendingGroundingMetadata;
        if (this.text) {
          yield this.buildFullTextResponse(
            this.text,
            this.isThought,
            gMetadataToYield,
          );
          this.text = '';
          this.isThought = false;
          gMetadataToYield = undefined;
        }
        if (this.toolCallParts.length > 0) {
          yield {
            content: {role: 'model', parts: this.toolCallParts},
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
          this.toolCallParts = [];
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
      }

      if (serverContent.interrupted) {
        if (this.text) {
          yield this.buildFullTextResponse(this.text, this.isThought);
          this.text = '';
          this.isThought = false;
        } else {
          yield {
            interrupted: serverContent.interrupted,
            ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
          };
        }
      }
    }

    if (message.toolCall) {
      if (this.text) {
        yield this.buildFullTextResponse(this.text, this.isThought);
        this.text = '';
        this.isThought = false;
      }
      if (message.toolCall.functionCalls) {
        this.toolCallParts.push(
          ...message.toolCall.functionCalls.map((fc) => ({
            functionCall: fc,
          })),
        );
      }

      const isGemini3x = isGemini3xFlashLive(this.modelVersion);
      if (isGemini3x && this.toolCallParts.length > 0) {
        yield {
          content: {role: 'model', parts: this.toolCallParts},
          ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
        };
        this.toolCallParts = [];
      }
    }

    if (message.sessionResumptionUpdate) {
      yield {
        liveSessionResumptionUpdate: message.sessionResumptionUpdate,
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }

    if (message.goAway) {
      yield {
        goAway: message.goAway,
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
    }
  }

  /**
   * Flushes any remaining aggregated components when the connection is closed.
   */
  *close(): Generator<LlmResponse, void, void> {
    if (this.toolCallParts.length > 0) {
      yield {
        content: {role: 'model', parts: this.toolCallParts},
        ...(this.modelVersion ? {modelVersion: this.modelVersion} : {}),
      };
      this.toolCallParts = [];
    }
  }

  private buildFullTextResponse(
    text: string,
    isThought: boolean,
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
}
