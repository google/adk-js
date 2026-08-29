/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session} from '../sessions/session.js';

/**
 * Marks a display name whose segments are base64url-encoded. Names without it
 * are the legacy dot-delimited form.
 */
const SOURCE_DISPLAY_NAME_PREFIX = 'adk-memory-v1.';

/** Number of segments in a source display name. */
const SOURCE_DISPLAY_NAME_SEGMENTS = 3;

const MILLISECONDS_PER_SECOND = 1000;

/** The RAG file a chunk came from, identified by its display name. */
export interface SourceIdentity {
  appName: string;
  userId: string;
  sessionId: string;
}

/** One line of a stored transcript. */
export interface TranscriptEvent {
  author: string;
  /** Epoch milliseconds. The transcript itself stores seconds. */
  timestamp: number;
  text: string;
}

function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

/**
 * Decodes one base64url segment, or returns `undefined` when it is not
 * canonical base64url. Node's decoder discards characters outside the alphabet
 * instead of failing, so `'!!!!'` would otherwise decode to an empty string
 * and let a malformed name match a tenant.
 */
function decodeSegment(segment: string): string | undefined {
  // An empty segment is the one input that survives the round trip below.
  if (!segment) {
    return undefined;
  }
  const decoded = Buffer.from(segment, 'base64url').toString('utf-8');
  return encodeSegment(decoded) === segment ? decoded : undefined;
}

/**
 * Builds the `displayName` under which a session's transcript is stored.
 *
 * The identifiers are encoded because they may contain dots, which the legacy
 * dot-delimited form cannot represent unambiguously.
 */
export function buildSourceDisplayName(
  appName: string,
  userId: string,
  sessionId: string,
): string {
  const segments = [appName, userId, sessionId].map(encodeSegment);
  return SOURCE_DISPLAY_NAME_PREFIX + segments.join('.');
}

/**
 * Recovers the identifiers from a `displayName`, or returns `undefined` when
 * the name is malformed or ambiguous.
 *
 * A legacy name with four or more parts is ambiguous: `demo.alice.smith.s1`
 * names either user `alice` or user `alice.smith`. Accepting it would hand one
 * user another user's memories, so it is rejected.
 */
export function parseSourceDisplayName(
  displayName: string,
): SourceIdentity | undefined {
  const isPrefixed = displayName.startsWith(SOURCE_DISPLAY_NAME_PREFIX);
  const raw = isPrefixed
    ? displayName.slice(SOURCE_DISPLAY_NAME_PREFIX.length)
    : displayName;
  const parts = raw.split('.');
  if (parts.length !== SOURCE_DISPLAY_NAME_SEGMENTS) {
    return undefined;
  }
  if (!isPrefixed) {
    return {appName: parts[0], userId: parts[1], sessionId: parts[2]};
  }
  const decoded = parts.map(decodeSegment);
  const [appName, userId, sessionId] = decoded;
  if (
    appName === undefined ||
    userId === undefined ||
    sessionId === undefined
  ) {
    return undefined;
  }
  return {appName, userId, sessionId};
}

/**
 * Renders a session as the newline-delimited JSON transcript that both ADK
 * implementations read, one object per text-bearing event.
 *
 * The timestamp is written in seconds because adk-python writes seconds; a
 * corpus is shared between the two.
 */
export function serializeSessionTranscript(session: Session): string {
  const lines: string[] = [];
  for (const event of session.events) {
    const texts: string[] = [];
    for (const part of event.content?.parts ?? []) {
      if (part.text) {
        texts.push(part.text.replaceAll('\n', ' '));
      }
    }
    if (texts.length === 0) {
      continue;
    }
    lines.push(
      JSON.stringify({
        author: event.author ?? '',
        timestamp: event.timestamp / MILLISECONDS_PER_SECOND,
        text: texts.join('.'),
      }),
    );
  }
  return lines.join('\n');
}

function parseTranscriptLine(line: string): TranscriptEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const seconds =
    typeof record['timestamp'] === 'number' ? record['timestamp'] : 0;
  return {
    author: typeof record['author'] === 'string' ? record['author'] : '',
    timestamp: seconds * MILLISECONDS_PER_SECOND,
    text: typeof record['text'] === 'string' ? record['text'] : '',
  };
}

/**
 * Reads the events out of a retrieved transcript chunk.
 *
 * A line that is not JSON is skipped: a corpus may hold files this service
 * never wrote.
 */
export function parseTranscriptEvents(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const event = parseTranscriptLine(line);
    if (event) {
      events.push(event);
    }
  }
  return events;
}
