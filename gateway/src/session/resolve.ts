/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Getting the ADK session a message belongs to, creating it when absent.
 *
 * `Runner.runAsync` throws on a missing session rather than creating one, so
 * every caller has to do this. Doing it here — once, with channel provenance
 * recorded — is a large part of what the gateway is for.
 */

import type {BaseSessionService, Session} from '@google/adk';

import type {
  InboundMessage,
  SessionConfig,
  SessionCoordinates,
} from '../types.js';
import {computeCoordinates, isEphemeral, parseDuration} from './strategies.js';

/** State key prefix recording where a session came from. */
export const PROVENANCE_PREFIX = 'gateway:';

/**
 * Session state keys carrying channel provenance.
 *
 * Namespaced with a colon, which exempts them from any state schema the user
 * declares on their agent (`State.validate` skips keys containing `':'`).
 *
 * These are load-bearing rather than decorative: proactive messaging resolves a
 * destination by reading them back off the session, and tools can tell where
 * they are without a side channel.
 */
export const ProvenanceKeys = {
  channel: 'gateway:channel',
  conversationId: 'gateway:conversationId',
  conversationKind: 'gateway:conversationKind',
  conversationTitle: 'gateway:conversationTitle',
  threadId: 'gateway:threadId',
} as const;

/** The outcome of resolving a message to a session. */
export interface ResolvedSession {
  session: Session;
  coordinates: SessionCoordinates;
  /** Whether the session was created by this call. */
  created: boolean;
  /** Whether it should be deleted once the turn finishes. */
  ephemeral: boolean;
}

/** What {@link resolveSession} needs. */
export interface ResolveSessionParams {
  sessionService: BaseSessionService;
  appName: string;
  message: InboundMessage;
  config: SessionConfig;
  /** Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Returns the session for a message, creating it when it does not exist and
 * rolling it over when it has been idle longer than
 * {@link SessionConfig.idleTtl}.
 */
export async function resolveSession(
  params: ResolveSessionParams,
): Promise<ResolvedSession> {
  const {sessionService, appName, message, config} = params;
  const now = params.now ?? Date.now;

  const coordinates = computeCoordinates(config, message);
  const ephemeral = isEphemeral(config);
  const key = {
    appName,
    userId: coordinates.userId,
    sessionId: coordinates.sessionId,
  };

  let session = ephemeral ? undefined : await sessionService.getSession(key);

  if (session && config.idleTtl !== undefined) {
    const ttlMs = parseDuration(config.idleTtl);
    // `lastUpdateTime` is epoch milliseconds, and is 0 on a session that has
    // never been written to — which is not idle, just new.
    const idleFor = now() - session.lastUpdateTime;
    if (session.lastUpdateTime > 0 && idleFor > ttlMs) {
      await sessionService.deleteSession(key);
      session = undefined;
    }
  }

  if (session) {
    return {session, coordinates, created: false, ephemeral};
  }

  const created = await sessionService.createSession({
    appName,
    userId: coordinates.userId,
    sessionId: coordinates.sessionId,
    state: provenanceState(message),
  });

  return {session: created, coordinates, created: true, ephemeral};
}

/** Deletes a session. Used by `/reset` and by the ephemeral strategy. */
export async function discardSession(
  sessionService: BaseSessionService,
  appName: string,
  coordinates: SessionCoordinates,
): Promise<void> {
  await sessionService.deleteSession({
    appName,
    userId: coordinates.userId,
    sessionId: coordinates.sessionId,
  });
}

/**
 * The provenance recorded on a session when it is created.
 *
 * Written once at creation rather than refreshed each turn: the conversation a
 * session belongs to never changes, and a write per turn to keep a chat title
 * current is not worth the round trip.
 */
export function provenanceState(
  message: InboundMessage,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    [ProvenanceKeys.channel]: message.channel,
    [ProvenanceKeys.conversationId]: message.conversation.id,
  };
  if (message.conversation.kind) {
    state[ProvenanceKeys.conversationKind] = message.conversation.kind;
  }
  if (message.conversation.title) {
    state[ProvenanceKeys.conversationTitle] = message.conversation.title;
  }
  if (message.conversation.threadId) {
    state[ProvenanceKeys.threadId] = message.conversation.threadId;
  }
  return state;
}
