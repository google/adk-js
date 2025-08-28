/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js'

// TODO - b/425992518: replace with lodash deep clone.
export function deepClone<T>(obj: T): T {
  if (obj === undefined) {
    return undefined as T;
  }

  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * Deep clones a session.
 * Should be kept in sync with Session constructor.
 *
 * @param session The session to clone.
 * @return The cloned session.
 */
export function deepCloneSession(session: Session): Session {
  return new Session({
    id: session.id,
    appName: session.appName,
    userId: session.userId,
    state: {...session.state},
    events: session.events.map((event) => new Event(event)),
    lastUpdateTime: session.lastUpdateTime,
  });
}