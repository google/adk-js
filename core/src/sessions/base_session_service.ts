/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

import {Session} from './session.js';
import {State} from './state.js';

/**
 * The configuration of getting a session.
 */
export interface GetSessionConfig {
  /** The number of recent events to retrieve. */
  numRecentEvents?: number;
  /** Retrieve events after this timestamp. */
  afterTimestamp?: number;
}

/**
 * The parameters for `createSession`.
 */
export interface CreateSessionRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
  /** The initial state of the session. */
  state?: Record<string, unknown>;
  /** The ID of the session. A new ID will be generated if not provided. */
  sessionId?: string;
}

/**
 * The parameters for `getSession`.
 */
export interface GetSessionRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
  /** The ID of the session. */
  sessionId: string;
  /** The configurations for getting the session. */
  config?: GetSessionConfig;
}

/**
 * The parameters for `listSessions`.
 */
export interface ListSessionsRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
}

/**
 * The parameters for `deleteSession`.
 */
export interface DeleteSessionRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
  /** The ID of the session. */
  sessionId: string;
}

/**
 * The parameters for `appendEvent`.
 */
export interface AppendEventRequest {
  /** The session to append the event to. */
  session: Session;
  /** The event to append. */
  event: Event;
}

/**
 * The response of listing sessions.
 *
 * The events and states are not set within each Session object.
 */
export interface ListSessionsResponse {
  /** A list of sessions. */
  sessions: Session[];
}

/**
 * Base class for session services.
 *
 * The service provides a set of methods for managing sessions and events.
 */
// TODO - b/425992518: can held session internally to make the API simpler.
export abstract class BaseSessionService {
  /**
   * Creates a new session.
   *
   * @param request The request to create a session.
   * @return A promise that resolves to the newly created session instance.
   */
  abstract createSession(request: CreateSessionRequest): Promise<Session>;

  /**
   * Gets a session.
   *
   * @param request The request to get a session.
   * @return A promise that resolves to the session instance or undefined if not
   *     found.
   */
  abstract getSession(request: GetSessionRequest): Promise<Session|undefined>;

  /**
   * Lists sessions for a user.
   *
   * @param request The request to list sessions.
   * @return A promise that resolves to a list of sessions for the user.
   */
  abstract listSessions(request: ListSessionsRequest):
      Promise<ListSessionsResponse>;

  /**
   * Deletes a session.
   *
   * @param request The request to delete a session.
   * @return A promise that resolves when the session is deleted.
   */
  abstract deleteSession(request: DeleteSessionRequest): Promise<void>;

  /**
   * Appends an event to a session.
   *
   * @param request The request to append an event.
   * @return A promise that resolves to the event that was appended.
   */
  async appendEvent({session, event}: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }

    this.updateSessionState({session, event});
    session.events.push(event);

    return event;
  }

  /**
   * Updates the session state based on the event.
   *
   * @param request The request to update the session state.
   */
  private updateSessionState({session, event}: AppendEventRequest): void {
    if (!event.actions || !event.actions.stateDelta) {
      return;
    }
    for (const [key, value] of Object.entries(event.actions.stateDelta)) {
      if (key.startsWith(State.TEMP_PREFIX)) {
        continue;
      }
      session.state[key] = value;
    }
  }
}
