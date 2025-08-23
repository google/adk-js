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
  numRecentEvents?: number;
  afterTimestamp?: number;
}

/**
 * The response of listing sessions.
 *
 * The events and states are not set within each Session object.
 */
export interface ListSessionsResponse {
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
   * @param appName the name of the app.
   * @param userId the id of the user.
   * @param state the initial state of the session.
   * @param sessionId the client-provided id of the session. If not provided, a
   *     generated ID will be used.
   * @return A promise that resolves to the newly created session instance.
   */
  abstract createSession(
      appName: string, userId: string, state?: Record<string, unknown>,
      sessionId?: string): Promise<Session>;

  /**
   * Gets a session.
   *
   * @param appName the name of the app.
   * @param userId the id of the user.
   * @param sessionId the id of the session.
   * @param config the configuration of getting the session.
   * @return A promise that resolves to the session instance or undefined if not
   *     found.
   */
  abstract getSession(
      appName: string, userId: string, sessionId: string,
      config?: GetSessionConfig): Promise<Session|undefined>;

  /**
   * Lists sessions for a user.
   *
   * @param appName the name of the app.
   * @param userId the id of the user.
   * @return A promise that resolves to a list of sessions for the user.
   */
  abstract listSessions(appName: string, userId: string):
      Promise<ListSessionsResponse>;

  /**
   * Deletes a session.
   *
   * @param appName the name of the app.
   * @param userId the id of the user.
   * @param sessionId the id of the session.
   * @return A promise that resolves when the session is deleted.
   */
  abstract deleteSession(appName: string, userId: string, sessionId: string):
      Promise<void>;

  /**
   * Appends an event to a session.
   *
   * @param session The session to append the event to.
   * @param event The event to append.
   * @return A promise that resolves to the event that was appended.
   */
  async appendEvent(session: Session, event: Event): Promise<Event> {
    if (event.partial) {
      return event;
    }

    this.updateSessionState(session, event);
    session.events.push(event);

    return event
  }

  /**
   * Updates the session state based on the event.
   *
   * @param session The session to update the state of.
   * @param event The event to update the state of.
   */
  private updateSessionState(session: Session, event: Event): void {
    if (!event.actions || !event.actions.stateDelta) {
      return
    }
    for (const [key, value] of Object.entries(event.actions.stateDelta)) {
      if (key.startsWith(State.TEMP_PREFIX)) {
        continue
      }
      session.state[key] = value;
    }
  }
}
