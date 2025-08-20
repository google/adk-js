/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'crypto';

import {Event} from '../events/event.js';

import {BaseSessionService, GetSessionConfig, ListSessionsResponse} from './base_session_service.js';
import {Session} from './session.js';
import {State} from './state.js';

/**
 * An in-memory implementation of the session service.
 */
export class InMemorySessionService extends BaseSessionService {
  /**
   * A map from app name to a map from user ID to a map from session ID to
   * session.
   */
  private sessions:
      Record<string, Record<string, Record<string, Session>>> = {};

  /**
   * A map from app name to a map from user ID to a map from key to the value.
   */
  private userState:
      Record<string, Record<string, Record<string, unknown>>> = {};

  /**
   * A map from app name to a map from key to the value.
   */
  private appState: Record<string, Record<string, unknown>> = {};

  createSession(
      appName: string, userId: string, state?: Record<string, unknown>,
      sessionId?: string): Promise<Session> {
    const session = new Session({
      id: sessionId || randomUUID(),
      appName,
      userId,
      state,
      events: [],
      lastUpdateTime: Date.now(),
    });

    if (!this.sessions[appName]) {
      this.sessions[appName] = {};
    }
    if (!this.sessions[appName][userId]) {
      this.sessions[appName][userId] = {};
    }

    this.sessions[appName][userId][session.id] = session;

    return Promise.resolve(
        this.mergeState(appName, userId, structuredClone(session)));
  }

  getSession(
      appName: string, userId: string, sessionId: string,
      config?: GetSessionConfig): Promise<Session|undefined> {
    if (!this.sessions[appName] || !this.sessions[appName][userId] ||
        !this.sessions[appName][userId][sessionId]) {
      return Promise.resolve(undefined);
    }

    const session: Session = this.sessions[appName][userId][sessionId];
    const copiedSession = structuredClone(session);

    // Re-hydrate the Event objects to restore their methods. We need this b/c structuredClone strips
    // methods.
    copiedSession.events = copiedSession.events.map(eventData => new Event(eventData));

    if (config) {
      if (config.numRecentEvents) {
        copiedSession.events =
            copiedSession.events.slice(-config.numRecentEvents);
      }
      if (config.afterTimestamp) {
        let i = copiedSession.events.length - 1;
        while (i >= 0) {
          if (copiedSession.events[i].timestamp < config.afterTimestamp) {
            break;
          }
          i--;
        }
        if (i >= 0) {
          copiedSession.events = copiedSession.events.slice(i + 1);
        }
      }
    }

    return Promise.resolve(this.mergeState(appName, userId, copiedSession));
  }

  listSessions(appName: string, userId: string): Promise<ListSessionsResponse> {
    if (!this.sessions[appName] || !this.sessions[appName][userId]) {
      return Promise.resolve({sessions: []});
    }

    const sessionsWithoutEvents: Session[] = [];
    for (const session of Object.values(this.sessions[appName][userId])) {
      sessionsWithoutEvents.push(new Session({
        id: session.id,
        appName: session.appName,
        userId: session.userId,
        state: {},
        events: [],
        lastUpdateTime: session.lastUpdateTime,
      }));
    }

    return Promise.resolve({sessions: sessionsWithoutEvents});
  }

  async deleteSession(appName: string, userId: string, sessionId: string):
      Promise<void> {
    const session = await this.getSession(appName, userId, sessionId);

    if (!session) {
      return;
    }

    delete this.sessions[appName][userId][sessionId];
  }

  override async appendEvent(session: Session, event: Event): Promise<Event> {
    await super.appendEvent(session, event);
    session.lastUpdateTime = event.timestamp;

    const appName = session.appName;
    const userId = session.userId;
    const sessionId = session.id;

    const warning = (message: string) => {
      console.warn(
          `Failed to append event to session ${sessionId}: ${message}`);
    };

    if (!this.sessions[appName]) {
      warning(`appName ${appName} not in sessions`);
      return event;
    }

    if (!this.sessions[appName][userId]) {
      warning(`userId ${userId} not in sessions[appName]`);
      return event;
    }

    if (!this.sessions[appName][userId][sessionId]) {
      warning(`sessionId ${sessionId} not in sessions[appName][userId]`);
      return event;
    }

    if (event.actions && event.actions.stateDelta) {
      for (const key of Object.keys(event.actions.stateDelta)) {
        if (key.startsWith(State.APP_PREFIX)) {
          this.appState[appName] = this.appState[appName] || {};
          this.appState[appName][key.replace(State.APP_PREFIX, '')] =
              event.actions.stateDelta[key];
        }

        if (key.startsWith(State.USER_PREFIX)) {
          this.userState[appName] = this.userState[appName] || {};
          this.userState[appName][userId] =
              this.userState[appName][userId] || {};
          this.userState[appName][userId][key.replace(State.USER_PREFIX, '')] =
              event.actions.stateDelta[key];
        }
      }
    }

    const storageSession: Session = this.sessions[appName][userId][sessionId];
    await super.appendEvent(storageSession, event);

    storageSession.lastUpdateTime = event.timestamp;

    return event;
  }

  private mergeState(
      appName: string,
      userId: string,
      copiedSession: Session,
      ): Session {
    if (this.appState[appName]) {
      for (const key of Object.keys(this.appState[appName])) {
        copiedSession.state[State.APP_PREFIX + key] =
            this.appState[appName][key];
      }
    }

    if (!this.userState[appName] || !this.userState[appName][userId]) {
      return copiedSession;
    }

    for (const key of Object.keys(this.userState[appName][userId])) {
      copiedSession.state[State.USER_PREFIX + key] =
          this.userState[appName][userId][key];
    }
    return copiedSession;
  }
}
