/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `Event.customMetadata` keys that only ADK code may write.
 *
 * Mirrors adk-python's `google.adk.events._internal_metadata`.
 */

import type {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import type {Event} from './event.js';

type Metadata = Record<string, unknown>;

/**
 * Prefix of `customMetadata` keys that callers cannot set.
 *
 * Keys with this prefix are dropped from the `customMetadata` passed to
 * `Runner.runAsync`, and from events that are restored into a session or
 * received from a remote A2A agent. Stored events keep them, but they are
 * removed from API responses, saved session files and A2A messages.
 *
 * The value matches adk-python so a session store shared between the two
 * treats the same keys as internal.
 */
export const INTERNAL_METADATA_PREFIX = '__adk_internal_';

/** Set on events that ADK restored into a session from outside it. */
export const RESTORED_EVENT_KEY = `${INTERNAL_METADATA_PREFIX}restored_event`;

function isMetadataObject(value: unknown): value is Metadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInternalKey(key: string): boolean {
  return key.startsWith(INTERNAL_METADATA_PREFIX);
}

function dropInternalKeys(metadata: Metadata): Metadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !isInternalKey(key)),
  );
}

function hasInternalKeys(metadata: unknown): boolean {
  return (
    isMetadataObject(metadata) && Object.keys(metadata).some(isInternalKey)
  );
}

/**
 * Returns `metadata` without keys that have the internal prefix.
 *
 * Use it where callers supply metadata. Dropped keys are logged at debug level,
 * because a caller set a key it cannot set.
 *
 * @param metadata A `customMetadata` value. It is not modified.
 * @returns A new object without internal keys. A value that is not a plain
 *     object, such as `undefined`, is returned unchanged.
 */
export function withoutInternalMetadata<T>(metadata: T): T {
  if (!isMetadataObject(metadata)) {
    return metadata;
  }
  const kept = dropInternalKeys(metadata);
  const dropped = Object.keys(metadata).filter(isInternalKey);
  if (dropped.length > 0) {
    logger.debug(
      `Dropping ADK-internal customMetadata keys: ${JSON.stringify(dropped.sort())}`,
    );
  }
  return kept as T;
}

/**
 * Returns `metadata` as callers see it, without internal keys.
 *
 * Use it where events leave ADK. Removal there is routine, so nothing is
 * logged.
 *
 * @param metadata A `customMetadata` value. It is not modified.
 * @returns A new object without internal keys, or `undefined` if nothing is
 *     left. A value that is not a plain object is returned unchanged.
 */
export function publicMetadata<T>(metadata: T): T | undefined {
  if (!isMetadataObject(metadata)) {
    return metadata;
  }
  const kept = dropInternalKeys(metadata);
  return Object.keys(kept).length > 0 ? (kept as T) : undefined;
}

/** Returns only the keys of `metadata` that have the internal prefix. */
export function internalMetadata(metadata: unknown): Metadata {
  if (!isMetadataObject(metadata)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => isInternalKey(key)),
  );
}

/**
 * Marks an event restored from outside the session, in place.
 *
 * Internal metadata carried by the event is removed first, so a caller cannot
 * supply its own.
 *
 * @param event The event about to be appended to a new session.
 * @returns The same event.
 */
export function markRestored<T extends Event>(event: T): T {
  event.customMetadata = {
    ...(withoutInternalMetadata(event.customMetadata) ?? {}),
    [RESTORED_EVENT_KEY]: true,
  };
  return event;
}

/**
 * Returns the event as callers see it, without internal metadata.
 *
 * @param event A stored event. It is not modified.
 * @returns The same event if it has no internal keys. Otherwise a copy whose
 *     `customMetadata` drops them, or is `undefined` if nothing else is left.
 */
export function publicEvent<T extends Event>(event: T): T {
  if (!hasInternalKeys(event.customMetadata)) {
    return event;
  }
  return {...event, customMetadata: publicMetadata(event.customMetadata)};
}

/**
 * Returns the session as callers see it, without internal metadata.
 *
 * @param session A stored session. It is not modified.
 * @returns The same session if no event changes. Otherwise a copy whose events
 *     are passed through {@link publicEvent}.
 */
export function publicSession<T extends Session>(session: T): T {
  const events = session.events ?? [];
  const publicEvents = events.map((event) => publicEvent(event));
  if (publicEvents.every((event, i) => event === events[i])) {
    return session;
  }
  return {...session, events: publicEvents};
}
