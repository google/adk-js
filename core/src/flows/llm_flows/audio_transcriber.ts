/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob, Content} from '@google/genai';

import {InvocationContext} from '../../agents/invocation_context.js';

/**
 * Audio encoding values matching Google Cloud Speech-to-Text `AudioEncoding`.
 */
export enum AudioEncoding {
  ENCODING_UNSPECIFIED = 0,
  LINEAR16 = 1,
}

/**
 * Configuration passed to a Speech-to-Text client `recognize` call.
 */
export interface RecognitionConfig {
  encoding: AudioEncoding | keyof typeof AudioEncoding | number;
  sampleRateHertz: number;
  languageCode: string;
}

/**
 * Audio payload passed to a Speech-to-Text client `recognize` call.
 */
export interface RecognitionAudio {
  content: Uint8Array | string;
}

/**
 * A single alternative hypothesis from a Speech-to-Text recognition result.
 */
export interface SpeechRecognitionAlternative {
  transcript?: string | null;
  confidence?: number | null;
}

/**
 * A single Speech-to-Text recognition result segment.
 */
export interface SpeechRecognitionResult {
  alternatives?: SpeechRecognitionAlternative[] | null;
}

/**
 * Response returned by a Speech-to-Text client `recognize` call.
 */
export interface RecognizeResponse {
  results?: SpeechRecognitionResult[] | null;
}

/**
 * Duck-typed interface compatible with `@google-cloud/speech`'s `SpeechClient`
 * as well as lightweight test or browser speech recognition clients.
 */
export interface SpeechClientLike {
  recognize(request: {
    config: RecognitionConfig;
    audio: RecognitionAudio;
  }):
    | Promise<RecognizeResponse | [RecognizeResponse, ...unknown[]]>
    | RecognizeResponse
    | [RecognizeResponse, ...unknown[]];
}

/**
 * Options for constructing an {@link AudioTranscriber}.
 */
export interface AudioTranscriberOptions {
  /**
   * Pre-configured Speech-to-Text client used to transcribe bundled user audio.
   */
  client?: SpeechClientLike;
}

function isSpeechClientLike(value: unknown): value is SpeechClientLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SpeechClientLike).recognize === 'function'
  );
}

function isContentEntry(data: Blob | Content): data is Content {
  return 'parts' in data || (!('data' in data) && !('mimeType' in data));
}

function blobDataToBytes(data: string | Uint8Array): Uint8Array {
  if (typeof data !== 'string') {
    return data;
  }
  if (
    data.length > 0 &&
    data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data)
  ) {
    const atobFn = (globalThis as {atob?: (encoded: string) => string}).atob;
    if (typeof Buffer === 'undefined' && typeof atobFn === 'function') {
      const binary = atobFn(data);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }
    return new Uint8Array(Buffer.from(data, 'base64'));
  }
  return new TextEncoder().encode(data);
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const merged = new Uint8Array(first.length + second.length);
  merged.set(first, 0);
  merged.set(second, first.length);
  return merged;
}

/**
 * Transcribes cached audio entries in an {@link InvocationContext} into
 * conversation `Content` objects.
 */
export class AudioTranscriber {
  client: SpeechClientLike;

  constructor(optionsOrClient?: AudioTranscriberOptions | SpeechClientLike) {
    if (isSpeechClientLike(optionsOrClient)) {
      this.client = optionsOrClient;
    } else if (optionsOrClient?.client) {
      this.client = optionsOrClient.client;
    } else {
      this.client = {
        recognize(): never {
          throw new Error(
            'SpeechClient is not configured on AudioTranscriber. Pass a SpeechClientLike implementation to new AudioTranscriber({client}).',
          );
        },
      };
    }
  }

  /**
   * Bundles consecutive audio blobs from the same speaker in
   * `invocationContext.transcriptionCache`, transcribes user audio bundles into
   * text `Content` entries, preserves already-transcribed `Content`
   * entries in order, clears `invocationContext.transcriptionCache`, and
   * returns the resulting content list.
   *
   * @param invocationContext The invocation context holding `transcriptionCache`.
   * @returns Ordered list of transcribed `Content` objects.
   */
  async transcribeFile(
    invocationContext: InvocationContext,
  ): Promise<Content[]> {
    const bundledAudio: Array<[string | undefined, Uint8Array | Content]> = [];
    const transcriptionHistory: Content[] = [];
    let currentSpeaker: string | undefined = undefined;
    let currentAudioData: Uint8Array = new Uint8Array(0);

    // Step 1: merge audio blobs because a single audio segment can be split
    // across multiple blobs.
    for (const transcriptionEntry of invocationContext.transcriptionCache ??
      []) {
      const speaker = transcriptionEntry.role;
      const audioData = transcriptionEntry.data;

      if (isContentEntry(audioData)) {
        if (currentSpeaker !== undefined) {
          bundledAudio.push([currentSpeaker, currentAudioData]);
          currentSpeaker = undefined;
          currentAudioData = new Uint8Array(0);
        }
        bundledAudio.push([speaker, audioData]);
        continue;
      }

      const rawData = (audioData as {data?: string | Uint8Array}).data;
      if (!rawData) {
        continue;
      }
      const chunkBytes = blobDataToBytes(rawData);
      if (chunkBytes.length === 0) {
        continue;
      }

      if (speaker === currentSpeaker) {
        currentAudioData = concatBytes(currentAudioData, chunkBytes);
      } else {
        if (currentSpeaker !== undefined) {
          bundledAudio.push([currentSpeaker, currentAudioData]);
        }
        currentSpeaker = speaker;
        currentAudioData = chunkBytes;
      }
    }

    if (currentSpeaker !== undefined) {
      bundledAudio.push([currentSpeaker, currentAudioData]);
    }

    // Reset cache.
    invocationContext.transcriptionCache = [];

    // Step 2: transcribe bundled audio entries into Content items.
    for (const [speaker, data] of bundledAudio) {
      if (ArrayBuffer.isView(data)) {
        const audio: RecognitionAudio = {content: data};
        const config: RecognitionConfig = {
          encoding: AudioEncoding.LINEAR16,
          sampleRateHertz: 16000,
          languageCode: 'en-US',
        };
        const rawResponse = await this.client.recognize({config, audio});
        const response = Array.isArray(rawResponse)
          ? rawResponse[0]
          : rawResponse;

        for (const result of response.results ?? []) {
          const transcript = result.alternatives?.[0]?.transcript;
          if (transcript !== undefined && transcript !== null) {
            transcriptionHistory.push({
              role: speaker ? speaker.toLowerCase() : 'user',
              parts: [{text: transcript}],
            });
          }
        }
      } else {
        transcriptionHistory.push(data);
      }
    }

    return transcriptionHistory;
  }
}
