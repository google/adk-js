/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob, LiveServerMessage, Session} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

import {
  GeminiLlmConnection,
  IncomingMessageBuffer,
} from '../../src/models/gemini_llm_connection.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {GoogleLLMVariant} from '../../src/utils/variant_utils.js';

interface FakeSession {
  sendClientContent: ReturnType<typeof vi.fn>;
  sendRealtimeInput: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createFakeSession(): FakeSession {
  return {
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
    close: vi.fn(),
  };
}

function createConnection(
  apiBackend: GoogleLLMVariant = GoogleLLMVariant.GEMINI_API,
): {
  connection: GeminiLlmConnection;
  session: FakeSession;
  buffer: IncomingMessageBuffer;
} {
  const session = createFakeSession();
  const buffer = new IncomingMessageBuffer();
  const connection = new GeminiLlmConnection(
    session as unknown as Session,
    buffer,
    apiBackend,
  );
  return {connection, session, buffer};
}

describe('GeminiLlmConnection.sendRealtime', () => {
  it('routes audio blobs through audio:', async () => {
    const {connection, session} = createConnection();
    const blob: Blob = {data: 'AAA=', mimeType: 'audio/pcm;rate=16000'};
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({audio: blob});
  });

  it('routes image blobs through video:', async () => {
    const {connection, session} = createConnection();
    const blob: Blob = {data: 'AAA=', mimeType: 'image/jpeg'};
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({video: blob});
  });

  it('falls back to media: for other mime types', async () => {
    const {connection, session} = createConnection();
    const blob: Blob = {data: 'AAA=', mimeType: 'application/octet-stream'};
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({media: blob});
  });

  it('falls back to media: when mimeType is missing', async () => {
    const {connection, session} = createConnection();
    const blob = {data: 'AAA='} as Blob;
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({media: blob});
  });
});

describe('GeminiLlmConnection.sendContent', () => {
  it('sends a single user text part via sendRealtimeInput.text', async () => {
    const {connection, session} = createConnection();
    await connection.sendContent({role: 'user', parts: [{text: 'hello'}]});
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({text: 'hello'});
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it('uses sendClientContent for multi-part user content', async () => {
    const {connection, session} = createConnection();
    const content = {
      role: 'user',
      parts: [{text: 'hello'}, {text: 'world'}],
    };
    await connection.sendContent(content);
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [content],
      turnComplete: true,
    });
    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
  });

  it('uses sendClientContent when content role is not user', async () => {
    const {connection, session} = createConnection();
    const content = {role: 'model', parts: [{text: 'hi'}]};
    await connection.sendContent(content);
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [content],
      turnComplete: true,
    });
    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
  });

  it('uses sendToolResponse for function response content', async () => {
    const {connection, session} = createConnection();
    const fr = {id: 'fc1', name: 'echo', response: {ok: true}};
    await connection.sendContent({
      role: 'user',
      parts: [{functionResponse: fr}],
    });
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [fr],
    });
  });

  it('throws when content has no parts', async () => {
    const {connection} = createConnection();
    await expect(connection.sendContent({role: 'user'})).rejects.toThrow(
      'Content must have parts.',
    );
  });
});

describe('GeminiLlmConnection.receive', () => {
  it('does not terminate after turnComplete and yields events for the next turn', async () => {
    const {connection, buffer} = createConnection();

    const turn1Audio: LiveServerMessage = {
      serverContent: {
        modelTurn: {
          role: 'model',
          parts: [{inlineData: {data: 'AAA=', mimeType: 'audio/pcm'}}],
        },
      },
    } as LiveServerMessage;
    const turn1Done: LiveServerMessage = {
      serverContent: {turnComplete: true},
    } as LiveServerMessage;
    const turn2Audio: LiveServerMessage = {
      serverContent: {
        modelTurn: {
          role: 'model',
          parts: [{inlineData: {data: 'BBB=', mimeType: 'audio/pcm'}}],
        },
      },
    } as LiveServerMessage;
    const turn2Done: LiveServerMessage = {
      serverContent: {turnComplete: true},
    } as LiveServerMessage;

    buffer.push({kind: 'message', message: turn1Audio});
    buffer.push({kind: 'message', message: turn1Done});
    buffer.push({kind: 'message', message: turn2Audio});
    buffer.push({kind: 'message', message: turn2Done});
    buffer.push({kind: 'close'});

    const events: LlmResponse[] = [];
    for await (const event of connection.receive()) {
      events.push(event);
    }

    const turnCompleteCount = events.filter((e) => e.turnComplete).length;
    expect(turnCompleteCount).toBe(2);

    const inlineDataChunks = events
      .map((e) => e.content?.parts?.[0]?.inlineData?.data)
      .filter(Boolean);
    expect(inlineDataChunks).toContain('AAA=');
    expect(inlineDataChunks).toContain('BBB=');
  });

  it('terminates when the buffer reports close', async () => {
    const {connection, buffer} = createConnection();
    buffer.push({kind: 'close'});

    const events: LlmResponse[] = [];
    for await (const event of connection.receive()) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });

  it('throws when the buffer reports an error', async () => {
    const {connection, buffer} = createConnection();
    buffer.push({kind: 'error', error: new Error('boom')});

    const consume = async () => {
      for await (const _ of connection.receive()) {
        // drain
      }
    };

    await expect(consume()).rejects.toThrow('boom');
  });
});
