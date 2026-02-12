/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Entity,
  FilterQuery,
  LockMode,
  MikroORM,
  Options,
  PrimaryKey,
  Property,
} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {cloneDeep} from 'lodash-es';

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
} from './base_session_service.js';
import {createSession, Session} from './session.js';
import {State} from './state.js';

const SCHEMA_VERSION_KEY = 'schema_version';
const SCHEMA_VERSION_1_JSON = '1';

@Entity({tableName: 'adk_internal_metadata'})
class StorageMetadata {
  @PrimaryKey({type: 'string'})
  key!: string;

  @Property({type: 'string'})
  value!: string;
}

@Entity({tableName: 'app_states'})
class StorageAppState {
  @PrimaryKey({type: 'string', fieldName: 'app_name'})
  appName!: string;

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    fieldName: 'update_time',
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updateTime?: Date;
}

@Entity({tableName: 'user_states'})
class StorageUserState {
  @PrimaryKey({type: 'string', fieldName: 'app_name'})
  appName!: string;

  @PrimaryKey({type: 'string', fieldName: 'user_id'})
  userId!: string;

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    fieldName: 'update_time',
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string];
}

@Entity({tableName: 'sessions'})
class StorageSession {
  @PrimaryKey({type: 'string'})
  id!: string;

  @PrimaryKey({type: 'string', fieldName: 'app_name'})
  appName!: string;

  @PrimaryKey({type: 'string', fieldName: 'user_id'})
  userId!: string;

  @Property({type: 'json'})
  state!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    fieldName: 'create_time',
    onCreate: () => new Date(),
  })
  createTime: Date = new Date();

  @Property({
    type: 'datetime',
    fieldName: 'update_time',
    onCreate: () => new Date(),
  })
  updateTime: Date = new Date();

  [PrimaryKey.name]?: [string, string, string];
}

@Entity({tableName: 'events'})
class StorageEvent {
  @PrimaryKey({type: 'string'})
  id!: string;

  @PrimaryKey({type: 'string', fieldName: 'app_name'})
  appName!: string;

  @PrimaryKey({type: 'string', fieldName: 'user_id'})
  userId!: string;

  @PrimaryKey({type: 'string', fieldName: 'session_id'})
  sessionId!: string;

  @Property({type: 'string', fieldName: 'invocation_id'})
  invocationId!: string;

  @Property({type: 'datetime'})
  timestamp!: Date;

  @Property({type: 'json', fieldName: 'event_data'})
  eventData!: Event;

  [PrimaryKey.name]?: [string, string, string, string];
}

const ENTITIES = [
  StorageMetadata,
  StorageAppState,
  StorageUserState,
  StorageSession,
  StorageEvent,
];

/**
 * A session service that uses a SQL database for storage via MikroORM.
 */
export class MikroOrmDatabaseSessionService extends BaseSessionService {
  private orm?: MikroORM;
  private initialized = false;
  private options: Options;

  constructor(options: Options) {
    super();
    this.options = {
      ...options,
      entities: ENTITIES,
      driver: options.driver || SqliteDriver,
    };
  }

  async init() {
    if (!this.initialized) {
      this.orm = await MikroORM.init(this.options);
      await this.orm.schema.updateSchema();
      await this.validateSchemaVersion();
      this.initialized = true;
    }
  }

  // This is requred to keep parity with Python ADK implementation.
  // Python ADK validates schema version before any database operations.
  private async validateSchemaVersion() {
    const em = this.orm!.em.fork();
    const existing = await em.findOne(StorageMetadata, {
      key: SCHEMA_VERSION_KEY,
    });

    if (existing) {
      if (existing.value !== SCHEMA_VERSION_1_JSON) {
        throw new Error(
          `ADK Database schema version ${existing.value} is not compatible.`,
        );
      }
      return;
    }

    const newVersion = em.create(StorageMetadata, {
      key: SCHEMA_VERSION_KEY,
      value: SCHEMA_VERSION_1_JSON,
    });
    await em.persistAndFlush(newVersion);
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

    const now = new Date();
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

    const storageEvents = await em.find(StorageEvent, eventWhere, {
      orderBy: {timestamp: 'DESC'},
      limit: config?.numRecentEvents,
    });

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

    const trimmedEvent = this.trimTempDeltaState(event);

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

function mergeStates(
  appState: Record<string, unknown>,
  userState: Record<string, unknown>,
  sessionState: Record<string, unknown>,
) {
  const merged = cloneDeep(sessionState);
  for (const [k, v] of Object.entries(appState)) {
    merged[State.APP_PREFIX + k] = v;
  }
  for (const [k, v] of Object.entries(userState)) {
    merged[State.USER_PREFIX + k] = v;
  }
  return merged;
}
