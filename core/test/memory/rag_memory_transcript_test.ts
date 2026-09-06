/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createSession} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  buildSourceDisplayName,
  parseSourceDisplayName,
  parseTranscriptEvents,
  serializeSessionTranscript,
} from '../../src/memory/rag_memory_transcript.js';

describe('buildSourceDisplayName and parseSourceDisplayName', () => {
  it('round-trips identifiers containing dots, slashes and non-ASCII', () => {
    const displayName = buildSourceDisplayName(
      'demo.app',
      'alice+smith/1',
      'session.ключ',
    );

    expect(displayName.startsWith('adk-memory-v1.')).toBe(true);
    expect(parseSourceDisplayName(displayName)).toEqual({
      appName: 'demo.app',
      userId: 'alice+smith/1',
      sessionId: 'session.ключ',
    });
  });

  it('rejects a prefixed name whose segment is not base64url', () => {
    expect(parseSourceDisplayName('adk-memory-v1.!!!!.ZGVtbw.c2Vzcw')).toBe(
      undefined,
    );
  });

  it('rejects a prefixed name whose segment carries padding', () => {
    expect(parseSourceDisplayName('adk-memory-v1.ZGVtbw==.YWxpY2U.cw')).toBe(
      undefined,
    );
  });

  it('rejects a prefixed name whose segment is empty', () => {
    expect(parseSourceDisplayName('adk-memory-v1..YWxpY2U.cw')).toBe(undefined);
  });

  it('rejects a prefixed name whose segment is non-canonical base64url', () => {
    // 'ZGVtbx' decodes to 'demo' as well, but re-encodes to 'ZGVtbw'.
    expect(parseSourceDisplayName('adk-memory-v1.ZGVtbx.YWxpY2U.cw')).toBe(
      undefined,
    );
  });

  it('rejects a prefixed name with two or four segments', () => {
    expect(parseSourceDisplayName('adk-memory-v1.ZGVtbw.YWxpY2U')).toBe(
      undefined,
    );
    expect(
      parseSourceDisplayName('adk-memory-v1.ZGVtbw.YWxpY2U.cw.ZXh0cmE'),
    ).toBe(undefined);
  });

  it('accepts a three-part legacy name as-is', () => {
    expect(parseSourceDisplayName('demo.alice.legacy_session')).toEqual({
      appName: 'demo',
      userId: 'alice',
      sessionId: 'legacy_session',
    });
  });

  it('rejects an ambiguous four-part legacy name', () => {
    expect(parseSourceDisplayName('demo.alice.smith.session_secret')).toBe(
      undefined,
    );
  });
});

describe('serializeSessionTranscript', () => {
  it('writes the timestamp in seconds', () => {
    const session = createSession({
      id: 'session-1',
      appName: 'demo',
      userId: 'alice',
      events: [
        createEvent({
          author: 'user',
          timestamp: 1_737_000_000_123,
          content: {parts: [{text: 'hello'}]},
        }),
      ],
    });

    expect(JSON.parse(serializeSessionTranscript(session))).toEqual({
      author: 'user',
      timestamp: 1737000000.123,
      text: 'hello',
    });
  });

  it('flattens newlines, joins text parts with a dot and skips text-free events', () => {
    const session = createSession({
      id: 'session-1',
      appName: 'demo',
      userId: 'alice',
      events: [
        createEvent({
          author: 'user',
          timestamp: 1000,
          content: {parts: [{text: 'first\nline'}, {text: 'second'}]},
        }),
        createEvent({author: 'model', timestamp: 2000}),
        createEvent({
          author: 'model',
          timestamp: 3000,
          content: {
            parts: [{inlineData: {data: 'aGk=', mimeType: 'image/png'}}],
          },
        }),
        createEvent({
          author: 'model',
          timestamp: 4000,
          content: {parts: [{text: 'last'}]},
        }),
      ],
    });

    expect(serializeSessionTranscript(session).split('\n')).toEqual([
      JSON.stringify({
        author: 'user',
        timestamp: 1,
        text: 'first line.second',
      }),
      JSON.stringify({author: 'model', timestamp: 4, text: 'last'}),
    ]);
  });

  it('writes an empty transcript for a session with no events', () => {
    const session = createSession({id: 'session-1', appName: 'demo'});

    expect(serializeSessionTranscript(session)).toBe('');
  });

  it('writes an empty author when the event has none', () => {
    const session = createSession({
      id: 'session-1',
      appName: 'demo',
      events: [
        createEvent({timestamp: 1000, content: {parts: [{text: 'hi'}]}}),
      ],
    });

    expect(JSON.parse(serializeSessionTranscript(session)).author).toBe('');
  });
});

describe('parseTranscriptEvents', () => {
  it('skips blank lines and lines that are not JSON', () => {
    const text = [
      JSON.stringify({author: 'user', timestamp: 1, text: 'first'}),
      '   ',
      'not json at all',
      JSON.stringify({author: 'model', timestamp: 2, text: 'second'}),
    ].join('\n');

    expect(parseTranscriptEvents(text)).toEqual([
      {author: 'user', timestamp: 1000, text: 'first'},
      {author: 'model', timestamp: 2000, text: 'second'},
    ]);
  });

  it('skips a JSON line that is not an object', () => {
    expect(parseTranscriptEvents('"a string"\nnull\n42')).toEqual([]);
  });

  it('defaults the fields a line does not carry', () => {
    expect(parseTranscriptEvents('{"timestamp": "not a number"}')).toEqual([
      {author: '', timestamp: 0, text: ''},
    ]);
  });

  it('returns no events for an empty transcript', () => {
    expect(parseTranscriptEvents('')).toEqual([]);
  });
});
