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

const GEMINI_31 = 'gemini-3.1-flash-live-preview';
const GEMINI_25 = 'gemini-2.5-flash-live-preview';

function createConnection(
  options: {apiBackend?: GoogleLLMVariant; modelVersion?: string} = {},
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
    options.apiBackend ?? GoogleLLMVariant.GEMINI_API,
    options.modelVersion ?? GEMINI_31,
  );
  return {connection, session, buffer};
}

describe('GeminiLlmConnection.sendRealtime', () => {
  it('routes audio blobs through audio: on Gemini 3.1', async () => {
    const {connection, session} = createConnection();
    const blob: Blob = {data: 'AAA=', mimeType: 'audio/pcm;rate=16000'};
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({audio: blob});
  });

  it('routes image blobs through video: on Gemini 3.1', async () => {
    const {connection, session} = createConnection();
    const blob: Blob = {data: 'AAA=', mimeType: 'image/jpeg'};
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({video: blob});
  });

  it('drops unknown mime types on Gemini 3.1 instead of guessing', async () => {
    const {connection, session} = createConnection();
    const blob: Blob = {data: 'AAA=', mimeType: 'application/octet-stream'};
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
  });

  it('routes blobs through media: on pre-3.1 models', async () => {
    const {connection, session} = createConnection({modelVersion: GEMINI_25});
    const blob: Blob = {data: 'AAA=', mimeType: 'audio/pcm;rate=16000'};
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({media: blob});
  });

  it('routes blobs with unknown mime via media: on pre-3.1 models', async () => {
    const {connection, session} = createConnection({modelVersion: GEMINI_25});
    const blob = {data: 'AAA='} as Blob;
    await connection.sendRealtime(blob);
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({media: blob});
  });
});

describe('GeminiLlmConnection.sendContent', () => {
  it('routes single user text via sendRealtimeInput on Gemini 3.1', async () => {
    const {connection, session} = createConnection();
    await connection.sendContent({role: 'user', parts: [{text: 'hello'}]});
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({text: 'hello'});
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it('routes single user text via sendClientContent on pre-3.1 models', async () => {
    const {connection, session} = createConnection({modelVersion: GEMINI_25});
    const content = {role: 'user', parts: [{text: 'hello'}]};
    await connection.sendContent(content);
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [content],
      turnComplete: true,
    });
    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
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

describe('GeminiLlmConnection.sendHistory', () => {
  it('does not send when history is empty', async () => {
    const {connection, session} = createConnection();
    await connection.sendHistory([]);
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it('seals turn when history ends with a user message', async () => {
    const {connection, session} = createConnection();
    const history = [
      {role: 'model', parts: [{text: 'hi'}]},
      {role: 'user', parts: [{text: 'hello'}]},
    ];
    await connection.sendHistory(history);
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: history,
      turnComplete: true,
    });
  });

  it('leaves turn open when history ends with a model message', async () => {
    const {connection, session} = createConnection();
    const history = [
      {role: 'user', parts: [{text: 'hello'}]},
      {role: 'model', parts: [{text: 'hi back'}]},
    ];
    await connection.sendHistory(history);
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: history,
      turnComplete: false,
    });
  });

  it('filters out audio parts before sending history', async () => {
    const {connection, session} = createConnection();
    const history = [
      {
        role: 'model',
        parts: [
          {text: 'hello'},
          {inlineData: {data: 'AAA=', mimeType: 'audio/pcm'}},
        ],
      },
    ];
    await connection.sendHistory(history);
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [{role: 'model', parts: [{text: 'hello'}]}],
      turnComplete: false,
    });
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

  it('yields goAway events from the server', async () => {
    const {connection, buffer} = createConnection();
    const goAway = {timeLeft: '1s'};
    buffer.push({
      kind: 'message',
      message: {goAway} as LiveServerMessage,
    });
    buffer.push({kind: 'close'});

    const events: LlmResponse[] = [];
    for await (const event of connection.receive()) {
      events.push(event);
    }

    const goAwayEvents = events.filter((e) => e.goAway);
    expect(goAwayEvents.length).toBe(1);
    expect(goAwayEvents[0].goAway).toEqual(goAway);
  });

  it('yields sessionResumptionUpdate events from the server', async () => {
    const {connection, buffer} = createConnection();
    const update = {newHandle: 'handle-123', resumable: true};
    buffer.push({
      kind: 'message',
      message: {sessionResumptionUpdate: update} as LiveServerMessage,
    });
    buffer.push({kind: 'close'});

    const events: LlmResponse[] = [];
    for await (const event of connection.receive()) {
      events.push(event);
    }

    const resumeEvents = events.filter((e) => e.liveSessionResumptionUpdate);
    expect(resumeEvents.length).toBe(1);
    expect(resumeEvents[0].liveSessionResumptionUpdate).toEqual(update);
  });
});
