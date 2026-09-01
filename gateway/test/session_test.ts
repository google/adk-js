/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService} from '@google/adk';
import {
  computeCoordinates,
  parseDuration,
  ProvenanceKeys,
  resolveSession,
  resolveSessionConfig,
  type InboundMessage,
  type SessionConfig,
} from '@google/adk-gateway';
import {describe, expect, it} from 'vitest';

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'tg',
    conversation: {channel: 'tg', id: 'chat-1', kind: 'group', title: 'Team'},
    sender: {id: 'u-1', displayName: 'Ada'},
    messageId: 'm-1',
    text: 'hello',
    attachments: [],
    mentionsBot: true,
    receivedAt: new Date(),
    raw: {},
    ...overrides,
  };
}

describe('resolveSessionConfig', () => {
  it('falls back to the channel default when nothing is given', () => {
    expect(resolveSessionConfig(undefined, 'per-thread')).toEqual({
      key: 'per-thread',
    });
  });

  it('expands a bare strategy name', () => {
    expect(resolveSessionConfig('per-user', 'per-conversation')).toEqual({
      key: 'per-user',
    });
  });

  it('passes an object through untouched', () => {
    const config: SessionConfig = {key: 'per-user', idleTtl: '1h'};
    expect(resolveSessionConfig(config, 'per-conversation')).toBe(config);
  });
});

describe('computeCoordinates', () => {
  it('namespaces the user by channel, so two channels cannot collide', () => {
    const {userId} = computeCoordinates({key: 'per-conversation'}, message());
    expect(userId).toBe('tg:u-1');
  });

  it('keys per-conversation on the chat, ignoring threads', () => {
    const withThread = message({
      conversation: {channel: 'tg', id: 'chat-1', threadId: 't-9'},
    });

    // Threads deliberately share: a channel that sets a thread id on every
    // reply would otherwise fragment into one session per reply.
    expect(
      computeCoordinates({key: 'per-conversation'}, withThread).sessionId,
    ).toBe(computeCoordinates({key: 'per-conversation'}, message()).sessionId);
  });

  it('keys per-thread on the thread when there is one', () => {
    const withThread = message({
      conversation: {channel: 'tg', id: 'chat-1', threadId: 't-9'},
    });
    expect(computeCoordinates({key: 'per-thread'}, withThread).sessionId).toBe(
      'tg:c:chat-1:t:t-9',
    );
  });

  it('falls back to the conversation when a per-thread message has no thread', () => {
    expect(computeCoordinates({key: 'per-thread'}, message()).sessionId).toBe(
      'tg:c:chat-1',
    );
  });

  it('keys per-user on the sender, across conversations', () => {
    const elsewhere = message({conversation: {channel: 'tg', id: 'other'}});
    expect(computeCoordinates({key: 'per-user'}, elsewhere).sessionId).toBe(
      computeCoordinates({key: 'per-user'}, message()).sessionId,
    );
  });

  it('gives every ephemeral message its own session', () => {
    const first = computeCoordinates({key: 'ephemeral'}, message());
    const second = computeCoordinates({key: 'ephemeral'}, message());
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it('defers to a caller-supplied function', () => {
    const config: SessionConfig = {
      key: (msg) => ({userId: `x-${msg.sender.id}`, sessionId: 'fixed'}),
    };
    expect(computeCoordinates(config, message())).toEqual({
      userId: 'x-u-1',
      sessionId: 'fixed',
    });
  });
});

describe('resolveSession', () => {
  const appName = 'app';

  it('creates the session when it does not exist', async () => {
    const sessionService = new InMemorySessionService();

    const resolved = await resolveSession({
      sessionService,
      appName,
      message: message(),
      config: {key: 'per-conversation'},
    });

    expect(resolved.created).toBe(true);
    expect(resolved.session.id).toBe('tg:c:chat-1');
  });

  it('reuses the session on the next message', async () => {
    const sessionService = new InMemorySessionService();
    const config: SessionConfig = {key: 'per-conversation'};

    await resolveSession({sessionService, appName, message: message(), config});
    const second = await resolveSession({
      sessionService,
      appName,
      message: message(),
      config,
    });

    expect(second.created).toBe(false);
  });

  it('records where the conversation came from', async () => {
    const sessionService = new InMemorySessionService();

    const {session} = await resolveSession({
      sessionService,
      appName,
      message: message(),
      config: {key: 'per-conversation'},
    });

    expect(session.state[ProvenanceKeys.channel]).toBe('tg');
    expect(session.state[ProvenanceKeys.conversationId]).toBe('chat-1');
    expect(session.state[ProvenanceKeys.conversationKind]).toBe('group');
    expect(session.state[ProvenanceKeys.conversationTitle]).toBe('Team');
  });

  it('uses provenance keys that survive a user-declared state schema', async () => {
    // `State.validate` exempts any key containing a colon, so gateway
    // bookkeeping cannot collide with a schema the user declared on the agent.
    for (const key of Object.values(ProvenanceKeys)) {
      expect(key).toContain(':');
    }
  });

  it('starts a fresh session once the idle window has passed', async () => {
    const sessionService = new InMemorySessionService();
    const config: SessionConfig = {key: 'per-conversation', idleTtl: '1h'};
    const msg = message();

    const first = await resolveSession({
      sessionService,
      appName,
      message: msg,
      config,
    });
    // Give it a last-update time, as a real turn would.
    first.session.lastUpdateTime = Date.now();

    const later = await resolveSession({
      sessionService,
      appName,
      message: msg,
      config,
      now: () => Date.now() + 2 * 60 * 60 * 1000,
    });

    expect(later.created).toBe(true);
    expect(later.session.events).toEqual([]);
  });

  it('keeps the session while it is still within the idle window', async () => {
    const sessionService = new InMemorySessionService();
    const config: SessionConfig = {key: 'per-conversation', idleTtl: '1h'};
    const msg = message();

    const first = await resolveSession({
      sessionService,
      appName,
      message: msg,
      config,
    });
    first.session.lastUpdateTime = Date.now();

    const later = await resolveSession({
      sessionService,
      appName,
      message: msg,
      config,
      now: () => Date.now() + 60 * 1000,
    });

    expect(later.created).toBe(false);
  });

  it('does not treat an unstamped session as infinitely idle', async () => {
    // `InMemorySessionService` stamps `lastUpdateTime` at creation, but the
    // `Session` contract lets it be 0 until the first event is written. A
    // service that leaves it unset must not read as idle since the epoch and
    // have every session discarded on sight.
    const sessionService = new UnstampedSessionService();
    const msg = message();

    const resolved = await resolveSession({
      sessionService,
      appName,
      message: msg,
      config: {key: 'per-conversation', idleTtl: '1ms'},
      now: () => Date.now() + 10_000,
    });

    expect(resolved.created).toBe(false);
    expect(sessionService.deleted).toBe(0);
  });
});

/** A session service that never stamps `lastUpdateTime`. */
class UnstampedSessionService extends InMemorySessionService {
  deleted = 0;

  override async getSession(
    request: Parameters<InMemorySessionService['getSession']>[0],
  ) {
    return {
      id: request.sessionId,
      appName: request.appName,
      userId: request.userId,
      state: {},
      events: [],
      lastUpdateTime: 0,
    };
  }

  override async deleteSession(
    request: Parameters<InMemorySessionService['deleteSession']>[0],
  ) {
    this.deleted++;
    await super.deleteSession(request);
  }
}

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['24h', 86_400_000],
    ['7d', 604_800_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('passes a number through as milliseconds', () => {
    expect(parseDuration(1234)).toBe(1234);
  });

  it('rejects nonsense rather than silently defaulting', () => {
    expect(() => parseDuration('soon')).toThrow(/Invalid duration/);
    expect(() => parseDuration(-1)).toThrow(/Invalid duration/);
  });
});
