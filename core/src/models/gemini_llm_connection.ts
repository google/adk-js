/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Blob,
  Content,
  FunctionResponse,
  LiveServerMessage,
  Part,
  Session,
  Transcription,
} from '@google/genai';

import {logger} from '../utils/logger.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmResponse} from './llm_response.js';

/**
 * Internal record passed from the GenAI websocket callbacks to `receive()`.
 */
type IncomingRecord =
  | {kind: 'message'; message: LiveServerMessage}
  | {kind: 'error'; error: Error}
  | {kind: 'close'};

/**
 * Buffers incoming events from a callback-based websocket so they can be
 * consumed as an async generator.
 */
export class IncomingMessageBuffer {
  private readonly queue: IncomingRecord[] = [];
  private readonly waiters: Array<(record: IncomingRecord) => void> = [];
  private terminated = false;

  push(record: IncomingRecord): void {
    if (this.terminated) {
      return;
    }
    if (record.kind !== 'message') {
      this.terminated = true;
    }
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve(record);
      return;
    }
    this.queue.push(record);
  }

  async pull(): Promise<IncomingRecord> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (this.terminated) {
      return {kind: 'close'};
    }
    return new Promise<IncomingRecord>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/**
 * The Gemini live model connection.
 *
 * Bridges the callback-based GenAI live `Session` and the ADK
 * `BaseLlmConnection` async-generator contract.
 */
export class GeminiLlmConnection implements BaseLlmConnection {
  private inputTranscriptionText = '';
  private outputTranscriptionText = '';

  constructor(
    private readonly geminiSession: Session,
    private readonly incomingMessages: IncomingMessageBuffer,
    private readonly apiBackend: GoogleLLMVariant = GoogleLLMVariant.GEMINI_API,
  ) {}

  /**
   * Sends the conversation history to the gemini model.
   *
   * Audio parts are filtered out: the live API does not accept previous-turn
   * audio via `sendClientContent`, and any audio has already been transcribed.
   *
   * @param history The conversation history to send to the model.
   */
  async sendHistory(history: Content[]): Promise<void> {
    const contents = history
      .map((content) => filterAudioParts(content))
      .filter((content): content is Content => content !== undefined);

    if (contents.length === 0) {
      logger.info('no content is sent');
      return;
    }

    this.geminiSession.sendClientContent({
      turns: contents,
      turnComplete: contents[contents.length - 1].role === 'user',
    });
  }

  /**
   * Sends a user content to the gemini model.
   *
   * If the content contains function responses, all parts must be function
   * responses; the call is dispatched as a tool response.
   *
   * @param content The content to send to the model.
   */
  async sendContent(content: Content): Promise<void> {
    if (!content.parts?.length) {
      throw new Error('Content must have parts.');
    }
    if (content.parts[0].functionResponse) {
      const functionResponses = content.parts
        .map((part) => part.functionResponse)
        .filter((fr): fr is FunctionResponse => !!fr);
      logger.debug('Sending LLM function response:', functionResponses);
      this.geminiSession.sendToolResponse({functionResponses});
      return;
    }
    logger.debug('Sending LLM new content', content);
    this.geminiSession.sendClientContent({
      turns: [content],
      turnComplete: true,
    });
  }

  /**
   * Sends a chunk of audio or a frame of video to the model in realtime.
   *
   * @param blob The blob to send to the model.
   */
  async sendRealtime(blob: Blob): Promise<void> {
    logger.debug('Sending LLM Blob.');
    this.geminiSession.sendRealtimeInput({media: blob});
  }

  /**
   * Sends an activity start signal to the model.
   */
  async sendActivityStart(): Promise<void> {
    this.geminiSession.sendRealtimeInput({activityStart: {}});
  }

  /**
   * Sends an activity end signal to the model.
   */
  async sendActivityEnd(): Promise<void> {
    this.geminiSession.sendRealtimeInput({activityEnd: {}});
  }

  /**
   * Receives the model response using the llm server connection.
   *
   * Yields one or more `LlmResponse`s per server message. Terminates when the
   * model signals `turnComplete`, the websocket closes, or an error occurs.
   *
   * @yields LlmResponse: The model response.
   */
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    let aggregatedText = '';
    let toolCallParts: Part[] = [];

    while (true) {
      const record = await this.incomingMessages.pull();
      if (record.kind === 'close') {
        break;
      }
      if (record.kind === 'error') {
        throw record.error;
      }
      const message = record.message;
      logger.debug('Got LLM Live message');

      if (message.usageMetadata) {
        yield {usageMetadata: message.usageMetadata};
      }

      if (message.serverContent) {
        const serverContent = message.serverContent;
        const content = serverContent.modelTurn;

        if (
          (!content || !content.parts?.length) &&
          serverContent.groundingMetadata &&
          !serverContent.turnComplete
        ) {
          yield {
            groundingMetadata: serverContent.groundingMetadata,
            interrupted: serverContent.interrupted,
          };
        }

        if (content?.parts?.length) {
          const llmResponse: LlmResponse = {
            content,
            interrupted: serverContent.interrupted,
          };
          if (!serverContent.turnComplete) {
            llmResponse.groundingMetadata = serverContent.groundingMetadata;
          }
          const firstPart = content.parts[0];
          if (firstPart.text) {
            aggregatedText += firstPart.text;
            llmResponse.partial = true;
          } else if (aggregatedText && !firstPart.inlineData) {
            yield buildFullTextResponse(aggregatedText);
            aggregatedText = '';
          }
          yield llmResponse;
        }

        if (serverContent.inputTranscription) {
          for (const event of this.handleTranscription(
            serverContent.inputTranscription,
            'input',
          )) {
            yield event;
          }
        }
        if (serverContent.outputTranscription) {
          for (const event of this.handleTranscription(
            serverContent.outputTranscription,
            'output',
          )) {
            yield event;
          }
        }

        // Gemini API may not emit a `finished` transcription. Flush pending
        // partial transcriptions on terminal control signals.
        if (
          this.apiBackend === GoogleLLMVariant.GEMINI_API &&
          (serverContent.interrupted ||
            serverContent.turnComplete ||
            serverContent.generationComplete)
        ) {
          for (const event of this.flushPendingTranscriptions()) {
            yield event;
          }
        }

        if (serverContent.turnComplete) {
          if (aggregatedText) {
            yield buildFullTextResponse(aggregatedText);
            aggregatedText = '';
          }
          if (toolCallParts.length > 0) {
            yield {content: {role: 'model', parts: toolCallParts}};
            toolCallParts = [];
          }
          yield {
            turnComplete: true,
            interrupted: serverContent.interrupted,
            groundingMetadata: serverContent.groundingMetadata,
          };
          break;
        }

        if (serverContent.interrupted) {
          if (aggregatedText) {
            yield buildFullTextResponse(aggregatedText);
            aggregatedText = '';
          } else {
            yield {interrupted: serverContent.interrupted};
          }
        }
      }

      if (message.toolCall?.functionCalls?.length) {
        if (aggregatedText) {
          yield buildFullTextResponse(aggregatedText);
          aggregatedText = '';
        }
        for (const functionCall of message.toolCall.functionCalls) {
          toolCallParts.push({functionCall});
        }
      }

      if (message.sessionResumptionUpdate) {
        yield {liveSessionResumptionUpdate: message.sessionResumptionUpdate};
      }
    }

    if (toolCallParts.length > 0) {
      yield {content: {role: 'model', parts: toolCallParts}};
    }
  }

  /**
   * Closes the llm server connection.
   */
  async close(): Promise<void> {
    this.geminiSession.close();
  }

  private *handleTranscription(
    transcription: Transcription,
    direction: 'input' | 'output',
  ): IterableIterator<LlmResponse> {
    const isInput = direction === 'input';
    if (transcription.text) {
      if (isInput) {
        this.inputTranscriptionText += transcription.text;
      } else {
        this.outputTranscriptionText += transcription.text;
      }
      const partial: Transcription = {
        text: transcription.text,
        finished: false,
      };
      yield isInput
        ? {inputTranscription: partial, partial: true}
        : {outputTranscription: partial, partial: true};
    }
    if (transcription.finished) {
      const accumulated = isInput
        ? this.inputTranscriptionText
        : this.outputTranscriptionText;
      const finished: Transcription = {text: accumulated, finished: true};
      if (isInput) {
        this.inputTranscriptionText = '';
      } else {
        this.outputTranscriptionText = '';
      }
      yield isInput
        ? {inputTranscription: finished, partial: false}
        : {outputTranscription: finished, partial: false};
    }
  }

  private *flushPendingTranscriptions(): IterableIterator<LlmResponse> {
    if (this.inputTranscriptionText) {
      const text = this.inputTranscriptionText;
      this.inputTranscriptionText = '';
      yield {
        inputTranscription: {text, finished: true},
        partial: false,
      };
    }
    if (this.outputTranscriptionText) {
      const text = this.outputTranscriptionText;
      this.outputTranscriptionText = '';
      yield {
        outputTranscription: {text, finished: true},
        partial: false,
      };
    }
  }
}

function buildFullTextResponse(text: string): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{text}],
    },
  };
}

/**
 * Removes inline audio parts from a content. Returns undefined if the content
 * has no remaining parts after filtering.
 */
function filterAudioParts(content: Content): Content | undefined {
  if (!content.parts?.length) {
    return content;
  }
  const filteredParts = content.parts.filter(
    (part) => !part.inlineData?.mimeType?.startsWith('audio/'),
  );
  if (filteredParts.length === 0) {
    return undefined;
  }
  return {...content, parts: filteredParts};
}
