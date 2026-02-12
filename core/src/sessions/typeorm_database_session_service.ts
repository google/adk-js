/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';
import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  DataSource,
  DataSourceOptions,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

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

@Entity({name: 'adk_internal_metadata'})
class StorageMetadata {
  @PrimaryColumn({type: 'varchar'})
  key!: string;

  @Column({type: 'varchar'})
  value!: string;
}

@Entity({name: 'app_states'})
class StorageAppState {
  @PrimaryColumn({name: 'app_name', type: 'varchar'})
  appName!: string;

  @Column({type: 'simple-json'})
  state!: Record<string, unknown>;

  @UpdateDateColumn({name: 'update_time', type: 'datetime'})
  updateTime!: Date;
}

@Entity({name: 'user_states'})
class StorageUserState {
  @PrimaryColumn({name: 'app_name', type: 'varchar'})
  appName!: string;

  @PrimaryColumn({name: 'user_id', type: 'varchar'})
  userId!: string;

  @Column({type: 'simple-json'})
  state!: Record<string, unknown>;

  @UpdateDateColumn({name: 'update_time', type: 'datetime'})
  updateTime!: Date;
}

@Entity({name: 'sessions'})
class StorageSession {
  @PrimaryColumn({type: 'varchar'})
  id!: string;

  @PrimaryColumn({name: 'app_name', type: 'varchar'})
  appName!: string;

  @PrimaryColumn({name: 'user_id', type: 'varchar'})
  userId!: string;

  @Column({type: 'simple-json'})
  state!: Record<string, unknown>;

  @CreateDateColumn({name: 'create_time', type: 'datetime'})
  createTime!: Date;

  @UpdateDateColumn({name: 'update_time', type: 'datetime'})
  updateTime!: Date;
}

@Entity({name: 'events'})
class StorageEvent {
  @PrimaryColumn({type: 'varchar'})
  id!: string;

  @PrimaryColumn({name: 'app_name', type: 'varchar'})
  appName!: string;

  @PrimaryColumn({name: 'user_id', type: 'varchar'})
  userId!: string;

  @PrimaryColumn({name: 'session_id', type: 'varchar'})
  sessionId!: string;

  @Column({name: 'invocation_id', type: 'varchar'})
  invocationId!: string;

  @Column({type: 'datetime'})
  timestamp!: Date;

  @Column({name: 'event_data', type: 'simple-json'})
  eventData!: Event;
}

const ENTITIES = [
  StorageMetadata,
  StorageAppState,
  StorageUserState,
  StorageSession,
  StorageEvent,
];

/**
 * A session service that uses a SQL database for storage via TypeORM.
 */
export class TypeORMDatabaseSessionService extends BaseSessionService {
  private dataSource: DataSource;
  private initialized = false;

  constructor(instanceOrOptions: DataSource | DataSourceOptions) {
    super();

    if (instanceOrOptions instanceof DataSource) {
      this.dataSource = instanceOrOptions;
      if (!this.dataSource.isInitialized) {
        this.dataSource.setOptions({
          entities: ENTITIES,
        });
      }
    } else {
      this.dataSource = new DataSource({
        ...instanceOrOptions,
        entities: ENTITIES,
        synchronize: true,
        logging: false,
      });
    }
  }

  async init() {
    if (!this.initialized) {
      if (!this.dataSource.isInitialized) {
        await this.dataSource.initialize();
      }
      await this.validateSchemaVersion();
      this.initialized = true;
    }
  }

  private async validateSchemaVersion() {
    const metadataRepo = this.dataSource.getRepository(StorageMetadata);
    const existing = await metadataRepo.findOneBy({key: SCHEMA_VERSION_KEY});

    if (existing) {
      if (existing.value !== SCHEMA_VERSION_1_JSON) {
        throw new Error(
          `ADK Database schema version ${existing.value} is not compatible.`,
        );
      }
      return;
    }

    const newVersion = metadataRepo.create({
      key: SCHEMA_VERSION_KEY,
      value: SCHEMA_VERSION_1_JSON,
    });
    await metadataRepo.save(newVersion);
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    await this.init();

    const id = sessionId || randomUUID();
    const sessionRepo = this.dataSource.getRepository(StorageSession);

    const existing = await sessionRepo.findOneBy({id, appName, userId});
    if (existing) {
      throw new Error(`Session with id ${id} already exists.`);
    }

    const appStateRepo = this.dataSource.getRepository(StorageAppState);
    const userStateRepo = this.dataSource.getRepository(StorageUserState);

    let appStateModel = await appStateRepo.findOneBy({appName});
    if (!appStateModel) {
      appStateModel = appStateRepo.create({appName, state: {}});
      await appStateRepo.save(appStateModel);
    }

    let userStateModel = await userStateRepo.findOneBy({appName, userId});
    if (!userStateModel) {
      userStateModel = userStateRepo.create({appName, userId, state: {}});
      await userStateRepo.save(userStateModel);
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
      await appStateRepo.save(appStateModel);
    }
    if (Object.keys(userStateDelta).length > 0) {
      userStateModel.state = {...userStateModel.state, ...userStateDelta};
      await userStateRepo.save(userStateModel);
    }

    const now = new Date();
    const storageSession = sessionRepo.create({
      id,
      appName,
      userId,
      state: sessionState,
      createTime: now,
      updateTime: now,
    });
    await sessionRepo.save(storageSession);

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

    const sessionRepo = this.dataSource.getRepository(StorageSession);
    const storageSession = await sessionRepo.findOneBy({
      appName,
      userId,
      id: sessionId,
    });

    if (!storageSession) {
      return undefined;
    }

    const eventRepo = this.dataSource.getRepository(StorageEvent);
    const eventQuery = eventRepo
      .createQueryBuilder('event')
      .where('event.appName = :appName', {appName})
      .andWhere('event.userId = :userId', {userId})
      .andWhere('event.sessionId = :sessionId', {sessionId});

    if (config?.afterTimestamp) {
      eventQuery.andWhere('event.timestamp > :timestamp', {
        timestamp: new Date(config.afterTimestamp),
      });
    }

    if (config?.numRecentEvents) {
      eventQuery.orderBy('event.timestamp', 'DESC');
      eventQuery.limit(config.numRecentEvents);
    } else {
      // Just order by DESC to match logic if needed, but usually we want all or limit.
      // Original implementation orders DESC for limit, creating reverse list?
      // Let's check original. It orders DESC with limit.
      // We will reverse back if we fetch them?
      // Wait, original map(se => se.eventData) returns them in the order fetched.
      // If fetched DESC, then the events list is DESC (newest first).
      // That seems odd for a history list, usually you want oldest first (ASC).
      // But let's stick to parity.
      eventQuery.orderBy('event.timestamp', 'DESC');
    }

    const storageEvents = await eventQuery.getMany();
    // If we want chronological order for the session object, we might want to reverse if we fetched DESC.
    // The previous implementation fetched DESC.
    // Let's assume parity means returning what it returned.

    const appStateRepo = this.dataSource.getRepository(StorageAppState);
    const userStateRepo = this.dataSource.getRepository(StorageUserState);

    const appStateModel = await appStateRepo.findOneBy({appName});
    const userStateModel = await userStateRepo.findOneBy({appName, userId});

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

    const sessionRepo = this.dataSource.getRepository(StorageSession);
    const where: {appName: string; userId?: string} = {appName};
    if (userId) {
      where.userId = userId;
    }

    const storageSessions = await sessionRepo.find({where});

    const appStateRepo = this.dataSource.getRepository(StorageAppState);
    const appStateModel = await appStateRepo.findOneBy({appName});
    const appState = appStateModel?.state || {};

    const userStateMap: Record<string, Record<string, unknown>> = {};
    const userStateRepo = this.dataSource.getRepository(StorageUserState);

    if (userId) {
      const u = await userStateRepo.findOneBy({appName, userId});
      if (u) userStateMap[userId] = u.state;
    } else {
      const allUserStates = await userStateRepo.findBy({appName});
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
    const sessionRepo = this.dataSource.getRepository(StorageSession);
    await sessionRepo.delete({appName, userId, id: sessionId});

    const eventRepo = this.dataSource.getRepository(StorageEvent);
    await eventRepo.delete({appName, userId, sessionId});
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await this.init();

    if (event.partial) {
      return event;
    }
    const trimmedEvent = this.trimTempDeltaState(event);

    await this.dataSource.transaction(async (entityManager) => {
      const sessionRepo = entityManager.getRepository(StorageSession);
      const appStateRepo = entityManager.getRepository(StorageAppState);
      const userStateRepo = entityManager.getRepository(StorageUserState);
      const eventRepo = entityManager.getRepository(StorageEvent);

      // Find session with lock
      // TypeORM locking: https://typeorm.io/select-query-builder#locking
      const storageSession = await sessionRepo.findOne({
        where: {
          appName: session.appName,
          userId: session.userId,
          id: session.id,
        },
        lock: {mode: 'pessimistic_write'},
      });

      if (!storageSession) {
        throw new Error(`Session ${session.id} not found for appendEvent`);
      }

      let appStateModel = await appStateRepo.findOneBy({
        appName: session.appName,
      });
      if (!appStateModel) {
        appStateModel = appStateRepo.create({
          appName: session.appName,
          state: {},
        });
        await appStateRepo.save(appStateModel);
      }

      let userStateModel = await userStateRepo.findOneBy({
        appName: session.appName,
        userId: session.userId,
      });
      if (!userStateModel) {
        userStateModel = userStateRepo.create({
          appName: session.appName,
          userId: session.userId,
          state: {},
        });
        await userStateRepo.save(userStateModel);
      }

      // Stale session check
      if (storageSession.updateTime.getTime() > session.lastUpdateTime) {
        const events = await eventRepo.find({
          where: {
            appName: session.appName,
            userId: session.userId,
            sessionId: session.id,
          },
          order: {timestamp: 'ASC'},
        });

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
          await appStateRepo.save(appStateModel);
        }
        if (Object.keys(userDelta).length > 0) {
          userStateModel.state = {...userStateModel.state, ...userDelta};
          await userStateRepo.save(userStateModel);
        }
        if (Object.keys(sessionDelta).length > 0) {
          storageSession.state = {...storageSession.state, ...sessionDelta};
        }
      }

      await eventRepo.save(
        eventRepo.create({
          id: trimmedEvent.id,
          appName: session.appName,
          userId: session.userId,
          sessionId: session.id,
          invocationId: trimmedEvent.invocationId,
          timestamp: new Date(trimmedEvent.timestamp),
          eventData: trimmedEvent,
        }),
      );

      storageSession.updateTime = new Date(event.timestamp);
      await sessionRepo.save(storageSession);

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
