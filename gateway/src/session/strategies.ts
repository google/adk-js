/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mapping inbound messages onto ADK session coordinates.
 *
 * The strategy is plain data — see {@link SessionKey} — because every knob that
 * exists applies to all four strategies equally. Nothing here touches storage;
 * `session/resolve.ts` does that.
 */

import type {
  InboundMessage,
  SessionConfig,
  SessionCoordinates,
  SessionKey,
} from '../types.js';

/** A counter making `ephemeral` session ids unique within a process. */
let ephemeralCounter = 0;

/**
 * Fills in a channel's session configuration from whatever the caller supplied.
 *
 * @param input What the caller passed to the channel factory, if anything.
 * @param fallback The channel's own default, used when the caller said nothing.
 */
export function resolveSessionConfig(
  input: SessionKey | SessionConfig | undefined,
  fallback: SessionKey,
): SessionConfig {
  if (input === undefined) {
    return {key: fallback};
  }
  if (typeof input === 'string') {
    return {key: input};
  }
  return input;
}

/**
 * Works out which ADK session a message belongs to.
 *
 * User ids are namespaced by channel because one session service may back
 * several channels, and Telegram user `12345` is not Slack user `12345`.
 */
export function computeCoordinates(
  config: SessionConfig,
  message: InboundMessage,
): SessionCoordinates {
  if (typeof config.key === 'function') {
    return config.key(message);
  }

  const {channel, conversation, sender} = message;
  const userId = `${channel}:${sender.id}`;

  switch (config.key) {
    case 'per-conversation':
      // Threads deliberately share one session: a channel where every reply
      // chain carries a thread id would otherwise fragment into a session per
      // reply. Use 'per-thread' where threads are genuinely separate rooms.
      return {userId, sessionId: `${channel}:c:${conversation.id}`};

    case 'per-thread':
      return {
        userId,
        sessionId: conversation.threadId
          ? `${channel}:c:${conversation.id}:t:${conversation.threadId}`
          : `${channel}:c:${conversation.id}`,
      };

    case 'per-user':
      return {userId, sessionId: `${channel}:u:${sender.id}`};

    case 'ephemeral':
      return {
        userId,
        sessionId: `${channel}:e:${Date.now()}:${++ephemeralCounter}`,
      };

    default: {
      // Exhaustiveness: a new SessionKey must be handled above.
      const unreachable: never = config.key;
      throw new Error(`Unknown session strategy: ${String(unreachable)}`);
    }
  }
}

/** Whether a strategy discards its session after each turn. */
export function isEphemeral(config: SessionConfig): boolean {
  return config.key === 'ephemeral';
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Turns `'24h'`, `'30m'`, `'90s'` or a plain number of milliseconds into
 * milliseconds.
 */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration: ${value}`);
    }
    return value;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid duration '${value}': expected a number of milliseconds or a ` +
        `string like '30s', '15m', '24h', '7d'.`,
    );
  }
  return Number(match[1]) * DURATION_UNITS[match[2]];
}
