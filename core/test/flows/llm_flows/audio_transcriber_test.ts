/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createSession, InvocationContext, PluginManager} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  AudioEncoding,
  AudioTranscriber,
  RecognizeResponse,
  SpeechClientLike,
} from '../../../src/flows/llm_flows/audio_transcriber.js';

function createInvocationContext(
  transcriptionCache?: InvocationContext['transcriptionCache'],
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-audio-1',
    session: createSession({
      id: 'sess-audio-1',
      userId: 'user-1',
      appName: 'app-audio',
    }),
    pluginManager: new PluginManager(),
    transcriptionCache,
  });
}

describe('AudioTranscriber', () => {
  it('returns an empty list and clears transcriptionCache when the cache is undefined or empty', async () => {
    const recognize = vi.fn<SpeechClientLike['recognize']>();
    const transcriber = new AudioTranscriber({client: {recognize}});

    const ctxUndefined = createInvocationContext(undefined);
    expect(await transcriber.transcribeFile(ctxUndefined)).toEqual([]);
    expect(ctxUndefined.transcriptionCache).toEqual([]);

    const ctxEmpty = createInvocationContext([]);
    expect(await transcriber.transcribeFile(ctxEmpty)).toEqual([]);
    expect(ctxEmpty.transcriptionCache).toEqual([]);
    expect(recognize).not.toHaveBeenCalled();
  });

  it('bundles consecutive user audio blobs into one recognize call and resets transcriptionCache', async () => {
    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6, 7, 8]);
    const recognize = vi.fn<SpeechClientLike['recognize']>().mockResolvedValue({
      results: [{alternatives: [{transcript: 'hello world'}]}],
    });
    const transcriber = new AudioTranscriber({recognize});
    const ctx = createInvocationContext([
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: Buffer.from(chunk1).toString('base64'),
        },
      },
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: Buffer.from(chunk2).toString('base64'),
        },
      },
    ]);

    const history = await transcriber.transcribeFile(ctx);

    expect(ctx.transcriptionCache).toEqual([]);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize).toHaveBeenCalledWith({
      config: {
        encoding: AudioEncoding.LINEAR16,
        sampleRateHertz: 16000,
        languageCode: 'en-US',
      },
      audio: {
        content: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      },
    });
    expect(history).toEqual([
      {
        role: 'user',
        parts: [{text: 'hello world'}],
      },
    ]);
  });

  it('skips blobs with empty or missing data without splitting a speaker bundle', async () => {
    const chunk1 = new Uint8Array([10, 20]);
    const chunk2 = new Uint8Array([30, 40]);
    const recognize = vi.fn<SpeechClientLike['recognize']>().mockResolvedValue([
      {
        results: [{alternatives: [{transcript: 'merged across empty blob'}]}],
      },
      undefined,
      undefined,
    ]);
    const transcriber = new AudioTranscriber({client: {recognize}});
    const ctx = createInvocationContext([
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: chunk1 as unknown as string,
        },
      },
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: '',
        },
      },
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
        },
      },
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: chunk2 as unknown as string,
        },
      },
    ]);

    const history = await transcriber.transcribeFile(ctx);

    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize).toHaveBeenCalledWith({
      config: {
        encoding: AudioEncoding.LINEAR16,
        sampleRateHertz: 16000,
        languageCode: 'en-US',
      },
      audio: {
        content: new Uint8Array([10, 20, 30, 40]),
      },
    });
    expect(history).toEqual([
      {
        role: 'user',
        parts: [{text: 'merged across empty blob'}],
      },
    ]);
  });

  it('flushes bundled user audio when a Content entry is encountered and preserves turn ordering', async () => {
    const modelContent: Content = {
      role: 'model',
      parts: [{text: 'How can I help?'}],
    };
    const recognize = vi
      .fn<SpeechClientLike['recognize']>()
      .mockResolvedValueOnce({
        results: [{alternatives: [{transcript: 'first user turn'}]}],
      })
      .mockResolvedValueOnce({
        results: [{alternatives: [{transcript: 'second user turn'}]}],
      });
    const transcriber = new AudioTranscriber({client: {recognize}});
    const ctx = createInvocationContext([
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: Buffer.from([1, 2]).toString('base64'),
        },
      },
      {
        role: 'model',
        data: modelContent,
      },
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: Buffer.from([3, 4]).toString('base64'),
        },
      },
    ]);

    const history = await transcriber.transcribeFile(ctx);

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(history).toEqual([
      {role: 'user', parts: [{text: 'first user turn'}]},
      modelContent,
      {role: 'user', parts: [{text: 'second user turn'}]},
    ]);
  });

  it('splits bundles on speaker change and emits one Content per recognition result segment', async () => {
    const modelContent: Content = {
      role: 'model',
      parts: [{text: 'model reply'}],
    };
    const recognize = vi.fn<SpeechClientLike['recognize']>().mockResolvedValue({
      results: [
        {alternatives: [{transcript: 'sentence one'}]},
        {alternatives: []},
        {alternatives: [{transcript: 'sentence two'}]},
      ],
    } satisfies RecognizeResponse);
    const transcriber = new AudioTranscriber({client: {recognize}});
    const ctx = createInvocationContext([
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: 'raw-user-audio',
        },
      },
      {
        role: 'model',
        data: modelContent,
      },
    ]);

    const history = await transcriber.transcribeFile(ctx);

    expect(recognize).toHaveBeenCalledTimes(1);
    expect(history).toEqual([
      {role: 'user', parts: [{text: 'sentence one'}]},
      {role: 'user', parts: [{text: 'sentence two'}]},
      modelContent,
    ]);
  });

  it('throws a descriptive error when recognize is called without a configured client', async () => {
    const transcriber = new AudioTranscriber();
    const ctx = createInvocationContext([
      {
        role: 'user',
        data: {
          mimeType: 'audio/pcm',
          data: Buffer.from([1, 2, 3, 4]).toString('base64'),
        },
      },
    ]);

    await expect(transcriber.transcribeFile(ctx)).rejects.toThrow(
      /SpeechClient is not configured on AudioTranscriber/,
    );
  });

  it('transcribes audio blobs whose speaker role is uppercase or non-user and normalizes role to lowercase', async () => {
    const recognize = vi
      .fn<SpeechClientLike['recognize']>()
      .mockResolvedValueOnce({
        results: [{alternatives: [{transcript: 'uppercase user audio'}]}],
      })
      .mockResolvedValueOnce({
        results: [{alternatives: [{transcript: 'model audio segment'}]}],
      });
    const transcriber = new AudioTranscriber({client: {recognize}});
    const ctx = createInvocationContext([
      {
        role: 'USER',
        data: {
          mimeType: 'audio/pcm',
          data: Buffer.from([1, 2]).toString('base64'),
        },
      },
      {
        role: 'model',
        data: {
          mimeType: 'audio/pcm',
          data: Buffer.from([3, 4]).toString('base64'),
        },
      },
    ]);

    const history = await transcriber.transcribeFile(ctx);

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(history).toEqual([
      {role: 'user', parts: [{text: 'uppercase user audio'}]},
      {role: 'model', parts: [{text: 'model audio segment'}]},
    ]);
  });
});
