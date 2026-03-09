/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FilterQuery,
  LockMode,
  Options as MikroDBOptions,
  MikroORM,
} from '@mikro-orm/core';

import {Event} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  trimTempDeltaState,
} from './base_session_service.js';
import {
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
  validateDatabaseSchemaVersion,
} from './db/operations.js';
import {
  ENTITIES,
  StorageAppState,
  StorageEvent,
  StorageSession,
  StorageUserState,
} from './db/schema.js';
import {createSession, Session} from './session.js';
import {State} from './state.js';

/**
 * Checks if a URI is a database connection URI.
 *
 * @param uri The URI to check.
 * @returns True if the URI is a database connection URI, false otherwise.
 */
export function isDatabaseConnectionString(uri?: string): boolean {
  if (!uri) {
    return false;
  }

  return (
    uri.startsWith('postgres://') ||
    uri.startsWith('postgresql://') ||
    uri.startsWith('mysql://') ||
    uri.startsWith('mariadb://') ||
    uri.startsWith('mssql://') ||
    uri.startsWith('sqlite://')
  );
}

/**
 * A session service that uses a SQL database for storage via MikroORM.
 */
export class DatabaseSessionService extends BaseSessionService {
  private orm?: MikroORM;
  private initialized = false;
  private options?: MikroDBOptions;
  private connectionString?: string;

  constructor(connectionStringOrOptions: MikroDBOptions | string) {
    super();
    if (typeof connectionStringOrOptions === 'string') {
      this.connectionString = connectionStringOrOptions;
    } else {
      if (!connectionStringOrOptions.driver) {
        throw new Error('Driver is required when passing options object.');
      }

      this.options = {
        ...connectionStringOrOptions,
        entities: ENTITIES,
      };
    }
  }

  async init() {
    if (this.initialized) {
      return;
    }

    if (this.connectionString && (!this.options || !this.options.driver)) {
      this.options = await getConnectionOptionsFromUri(this.connectionString);
    }

    this.orm = await MikroORM.init(this.options!);
    await ensureDatabaseCreated(this.orm!);
    await validateDatabaseSchemaVersion(this.orm!);
    this.initialized = true;
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    await this.init();
    const em = this.orm!.em.fork();

    const id = sessionId || randomUUID();
    const now = new Date();
    const existing = await em.findOne(StorageSession, {
      id,
      appName,
      userId,
    });
    if (existing) {
      throw new Error(`Session with id ${id} already exists.`);
    }

    let appStateModel = await em.findOne(StorageAppState, {appName});
    if (!appStateModel) {
      appStateModel = em.create(StorageAppState, {
        appName,
        state: {},
        updateTime: now,
      });
      em.persist(appStateModel);
    }

    let userStateModel = await em.findOne(StorageUserState, {appName, userId});
    if (!userStateModel) {
      userStateModel = em.create(StorageUserState, {
        appName,
        userId,
        state: {},
      });
      em.persist(userStateModel);
    }

    const appStateDelta: Record<string, unknown> = {};
    const userStateDelta: Record<string, unknown> = {};
    const sessionState: Record<string, unknown> = {};

    if (state) {
      for (const [key, value] of Object.entries(state)) {
        if (key.startsWith(State.APP_PREFIX)) {
          appStateDelta[key.replace(State.APP_PREFIX, '')] = value;
        } else if (key.startsWith(State.USER_PREFIX)) {
          userStateDelta[key.replace(State.USER_PREFIX, '')] = value;
        } else {
          sessionState[key] = value;
        }
      }
    }

    if (Object.keys(appStateDelta).length > 0) {
      appStateModel.state = {...appStateModel.state, ...appStateDelta};
    }
    if (Object.keys(userStateDelta).length > 0) {
      userStateModel.state = {...userStateModel.state, ...userStateDelta};
    }

    const storageSession = em.create(StorageSession, {
      id,
      appName,
      userId,
      state: sessionState,
      createTime: now,
      updateTime: now,
    });
    em.persist(storageSession);

    await em.flush();

    const mergedState = mergeStates(
      appStateModel.state,
      userStateModel.state,
      sessionState,
    );

    return createSession({
      id,
      appName,
      userId,
      state: mergedState,
      events: [],
      lastUpdateTime: storageSession.createTime.getTime(),
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    await this.init();
    const em = this.orm!.em.fork();

    const storageSession = await em.findOne(StorageSession, {
      appName,
      userId,
      id: sessionId,
    });

    if (!storageSession) {
      return undefined;
    }

    const eventWhere: FilterQuery<StorageEvent> = {
      appName,
      userId,
      sessionId,
    };

    if (config?.afterTimestamp) {
      eventWhere.timestamp = {$gt: new Date(config.afterTimestamp)};
    }

    // Get latest numRecentEvents events or all events in DESC order
    const storageEvents = await em.find(StorageEvent, eventWhere, {
      orderBy: {timestamp: 'DESC'},
      limit: config?.numRecentEvents,
    });
    // Reverse the events to maintain the original order as we get events in DESC order
    // to get the latest events first.
    storageEvents.reverse();

    const appStateModel = await em.findOne(StorageAppState, {appName});
    const userStateModel = await em.findOne(StorageUserState, {
      appName,
      userId,
    });

    const mergedState = mergeStates(
      appStateModel?.state || {},
      userStateModel?.state || {},
      storageSession.state,
    );

    return createSession({
      id: sessionId,
      appName,
      userId,
      state: mergedState,
      events: storageEvents.map((se) => se.eventData),
      lastUpdateTime: storageSession.updateTime.getTime(),
    });
  }

  async listSessions({
    appName,
    userId,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    await this.init();
    const em = this.orm!.em.fork();

    const where: FilterQuery<StorageSession> = {appName};
    if (userId) {
      where.userId = userId;
    }

    const storageSessions = await em.find(StorageSession, where);
    const appStateModel = await em.findOne(StorageAppState, {appName});
    const appState = appStateModel?.state || {};
    const userStateMap: Record<string, Record<string, unknown>> = {};

    if (userId) {
      const u = await em.findOne(StorageUserState, {appName, userId});
      if (u) userStateMap[userId] = u.state;
    } else {
      const allUserStates = await em.find(StorageUserState, {appName});
      for (const u of allUserStates) {
        userStateMap[u.userId] = u.state;
      }
    }

    const sessions = storageSessions.map((ss) => {
      const uState = userStateMap[ss.userId] || {};
      const merged = mergeStates(appState, uState, ss.state);
      return createSession({
        id: ss.id,
        appName: ss.appName,
        userId: ss.userId,
        state: merged,
        events: [],
        lastUpdateTime: ss.updateTime.getTime(),
      });
    });

    return {sessions};
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    await this.init();
    const em = this.orm!.em.fork();

    await em.nativeDelete(StorageSession, {appName, userId, id: sessionId});
    await em.nativeDelete(StorageEvent, {appName, userId, sessionId});
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await this.init();
    const em = this.orm!.em.fork();

    if (event.partial) {
      return event;
    }

    const trimmedEvent = trimTempDeltaState(event);

    await em.transactional(async (txEm) => {
      const storageSession = await txEm.findOne(
        StorageSession,
        {
          appName: session.appName,
          userId: session.userId,
          id: session.id,
        },
        {lockMode: LockMode.PESSIMISTIC_WRITE},
      );

      if (!storageSession) {
        throw new Error(`Session ${session.id} not found for appendEvent`);
      }

      let appStateModel = await txEm.findOne(StorageAppState, {
        appName: session.appName,
      });
      if (!appStateModel) {
        appStateModel = txEm.create(StorageAppState, {
          appName: session.appName,
          state: {},
          updateTime: new Date(),
        });
        txEm.persist(appStateModel);
      }

      let userStateModel = await txEm.findOne(StorageUserState, {
        appName: session.appName,
        userId: session.userId,
      });
      if (!userStateModel) {
        userStateModel = txEm.create(StorageUserState, {
          appName: session.appName,
          userId: session.userId,
          state: {},
        });
        txEm.persist(userStateModel);
      }

      // Stale session check
      if (storageSession.updateTime.getTime() > session.lastUpdateTime) {
        // Reload state
        const events = await txEm.find(
          StorageEvent,
          {
            appName: session.appName,
            userId: session.userId,
            sessionId: session.id,
          },
          {orderBy: {timestamp: 'ASC'}},
        );

        const mergedState = mergeStates(
          appStateModel.state,
          userStateModel.state,
          storageSession.state,
        );
        session.state = mergedState;
        session.events = events.map((e) => e.eventData);
      }

      if (event.actions && event.actions.stateDelta) {
        const appDelta: Record<string, unknown> = {};
        const userDelta: Record<string, unknown> = {};
        const sessionDelta: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(event.actions.stateDelta)) {
          if (key.startsWith(State.APP_PREFIX)) {
            appDelta[key.replace(State.APP_PREFIX, '')] = value;
          } else if (key.startsWith(State.USER_PREFIX)) {
            userDelta[key.replace(State.USER_PREFIX, '')] = value;
          } else {
            sessionDelta[key] = value;
          }
        }

        if (Object.keys(appDelta).length > 0) {
          appStateModel.state = {...appStateModel.state, ...appDelta};
        }
        if (Object.keys(userDelta).length > 0) {
          userStateModel.state = {...userStateModel.state, ...userDelta};
        }
        if (Object.keys(sessionDelta).length > 0) {
          storageSession.state = {...storageSession.state, ...sessionDelta};
        }
      }

      const newStorageEvent = txEm.create(StorageEvent, {
        id: trimmedEvent.id,
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
        invocationId: trimmedEvent.invocationId,
        timestamp: new Date(trimmedEvent.timestamp),
        eventData: trimmedEvent,
      });
      txEm.persist(newStorageEvent);
      await txEm.commit();

      // Update session timestamp to match event timestamp
      storageSession.updateTime = new Date(event.timestamp);

      const newMergedState = mergeStates(
        appStateModel.state,
        userStateModel.state,
        storageSession.state,
      );
      session.state = newMergedState;
      session.events.push(event);
      session.lastUpdateTime = storageSession.updateTime.getTime();
    });

    return event;
  }
}
