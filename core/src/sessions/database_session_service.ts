/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';
import {Op, WhereOptions} from 'sequelize';
import {
  Column,
  DataType,
  Model,
  Sequelize,
  SequelizeOptions,
  Table,
} from 'sequelize-typescript';

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

@Table({
  tableName: 'adk_internal_metadata',
  timestamps: false,
})
class StorageMetadata extends Model {
  @Column({primaryKey: true, type: DataType.STRING})
  declare key: string;

  @Column({type: DataType.STRING})
  declare value: string;
}

@Table({
  tableName: 'app_states',
  timestamps: false,
})
class StorageAppState extends Model {
  @Column({primaryKey: true, type: DataType.STRING, field: 'app_name'})
  declare appName: string;

  @Column({type: DataType.JSON})
  declare state: Record<string, unknown>;

  @Column({
    type: DataType.DATE(6),
    defaultValue: DataType.NOW,
    field: 'update_time',
  })
  declare updateTime: Date;
}

@Table({
  tableName: 'user_states',
  timestamps: false,
})
class StorageUserState extends Model {
  @Column({primaryKey: true, type: DataType.STRING, field: 'app_name'})
  declare appName: string;

  @Column({primaryKey: true, type: DataType.STRING, field: 'user_id'})
  declare userId: string;

  @Column({type: DataType.JSON})
  declare state: Record<string, unknown>;

  @Column({
    type: DataType.DATE(6),
    defaultValue: DataType.NOW,
    field: 'update_time',
  })
  declare updateTime: Date;
}

@Table({
  tableName: 'sessions',
  timestamps: false,
})
class StorageSession extends Model {
  @Column({primaryKey: true, type: DataType.STRING})
  declare id: string;

  @Column({primaryKey: true, type: DataType.STRING, field: 'app_name'})
  declare appName: string;

  @Column({primaryKey: true, type: DataType.STRING, field: 'user_id'})
  declare userId: string;

  @Column({type: DataType.JSON})
  declare state: Record<string, unknown>;

  @Column({
    type: DataType.DATE(6),
    defaultValue: DataType.NOW,
    field: 'create_time',
  })
  declare createTime: Date;

  @Column({
    type: DataType.DATE(6),
    defaultValue: DataType.NOW,
    field: 'update_time',
  })
  declare updateTime: Date;
}

@Table({tableName: 'events', timestamps: false})
class StorageEvent extends Model {
  @Column({primaryKey: true, type: DataType.STRING})
  declare id: string;

  @Column({primaryKey: true, type: DataType.STRING, field: 'app_name'})
  declare appName: string;

  @Column({primaryKey: true, type: DataType.STRING, field: 'user_id'})
  declare userId: string;

  @Column({primaryKey: true, type: DataType.STRING, field: 'session_id'})
  declare sessionId: string;

  @Column({type: DataType.STRING, field: 'invocation_id'})
  declare invocationId: string;

  @Column({type: DataType.DATE(6)})
  declare timestamp: Date;

  @Column({type: DataType.JSON, field: 'event_data'})
  //TODO: @kalenkevich - Support snake_case notation for event_data
  declare eventData: Event;
}

const MODELS = [
  StorageMetadata,
  StorageAppState,
  StorageUserState,
  StorageSession,
  StorageEvent,
];

const SUPPORTED_PROTOCOLS = [
  'postgresql://',
  'sqlite://',
  'mysql://',
  'mssql://',
  'mariadb://',
  'db2://',
  'snowflake://',
  'oracle://',
];

/**
 * Checks if the given URI is a database connection string.
 */
export function isDatabaseConnectionString(uri?: string): boolean {
  return (
    !!uri && SUPPORTED_PROTOCOLS.some((protocol) => uri.startsWith(protocol))
  );
}

/**
 * A session service that uses a SQL database for storage via Sequelize.
 */
export class DatabaseSessionService extends BaseSessionService {
  private sequelize: Sequelize;
  private initialized = false;

  constructor(instanceOrOptionsOrUrl: Sequelize | SequelizeOptions | string) {
    super();

    if (typeof instanceOrOptionsOrUrl === 'string') {
      this.sequelize = new Sequelize(instanceOrOptionsOrUrl, {
        models: MODELS,
        logging: false,
      });
    } else if (instanceOrOptionsOrUrl instanceof Sequelize) {
      this.sequelize = instanceOrOptionsOrUrl;
      this.sequelize.addModels(MODELS);
    } else {
      this.sequelize = new Sequelize({
        ...instanceOrOptionsOrUrl,
        models: MODELS,
        logging: false,
      });
    }
  }

  async init() {
    if (!this.initialized) {
      await this.sequelize.sync();
      await this.validateSchemaVersion();
      this.initialized = true;
    }
  }

  // This is requred to keep parity with Python ADK implementation.
  // Python ADK validates schema version before any database operations.
  private async validateSchemaVersion() {
    const existing = await StorageMetadata.findOne({
      where: {key: SCHEMA_VERSION_KEY},
    });

    if (existing) {
      if (existing.value !== SCHEMA_VERSION_1_JSON) {
        throw new Error(
          `ADK Database schema version ${existing.value} is not compatible.`,
        );
      }
      return;
    }

    await StorageMetadata.findOrCreate({
      where: {key: SCHEMA_VERSION_KEY},
      defaults: {key: SCHEMA_VERSION_KEY, value: SCHEMA_VERSION_1_JSON},
    });
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    await this.init();

    const id = sessionId || randomUUID();

    const existing = await StorageSession.findOne({
      where: {id, appName, userId},
    });
    if (existing) {
      throw new Error(`Session with id ${id} already exists.`);
    }

    const [appStateModel] = await StorageAppState.findOrCreate({
      where: {appName},
      defaults: {appName, state: {}},
    });

    const [userStateModel] = await StorageUserState.findOrCreate({
      where: {appName, userId},
      defaults: {appName, userId, state: {}},
    });

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
      await appStateModel.save();
    }
    if (Object.keys(userStateDelta).length > 0) {
      userStateModel.state = {...userStateModel.state, ...userStateDelta};
      await userStateModel.save();
    }

    const now = Date.now();
    // In database implementation, we persist the session state
    const storageSession = await StorageSession.create({
      id,
      appName,
      userId,
      state: sessionState,
      // timestamps handled by sequelize
    });

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
      lastUpdateTime: storageSession.createTime
        ? storageSession.createTime.getTime()
        : now,
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    await this.init();

    const storageSession = await StorageSession.findOne({
      where: {appName, userId, id: sessionId},
    });

    if (!storageSession) {
      return undefined;
    }

    const eventWhere: WhereOptions<StorageEvent> = {
      appName,
      userId,
      sessionId,
    };

    if (config?.afterTimestamp) {
      eventWhere.timestamp = {
        [Op.gt]: config.afterTimestamp,
      };
    }

    const storageEvents = await StorageEvent.findAll({
      where: eventWhere,
      limit: config?.numRecentEvents,
      order: [['timestamp', 'ASC']],
    });

    const appStateModel = await StorageAppState.findByPk(appName);
    const userStateModel = await StorageUserState.findOne({
      where: {appName, userId},
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
      lastUpdateTime: storageSession.updateTime
        ? storageSession.updateTime.getTime()
        : Date.now(),
    });
  }

  async listSessions({
    appName,
    userId,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    await this.init();

    const where: WhereOptions<StorageSession> = {appName};
    if (userId) {
      where.userId = userId;
    }

    const storageSessions = await StorageSession.findAll({where});
    const appStateModel = await StorageAppState.findByPk(appName);
    const appState = appStateModel?.state || {};
    const userStateMap: Record<string, Record<string, unknown>> = {};

    if (userId) {
      const u = await StorageUserState.findOne({
        where: {appName, userId},
      });
      if (u) userStateMap[userId] = u.state;
    } else {
      // NOTE: This might need adjustment if findOrCreate/findAll uses different WHERE structure for snake_case column mapping in some seq versions,
      // but usually with field option it should work with camelCase in where.
      const allUserStates = await StorageUserState.findAll({
        where: {appName},
      });
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
        lastUpdateTime: ss.updateTime ? ss.updateTime.getTime() : Date.now(),
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
    await StorageSession.destroy({
      where: {appName, userId, id: sessionId},
    });
    await StorageEvent.destroy({
      where: {appName, userId, sessionId},
    });
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await this.init();

    const storageSession = await StorageSession.findOne({
      where: {
        appName: session.appName,
        userId: session.userId,
        id: session.id,
      },
    });

    if (!storageSession) {
      throw new Error(`Session ${session.id} not found for appendEvent`);
    }

    const [appStateModel] = await StorageAppState.findOrCreate({
      where: {appName: session.appName},
      defaults: {appName: session.appName, state: {}},
    });
    const [userStateModel] = await StorageUserState.findOrCreate({
      where: {appName: session.appName, userId: session.userId},
      defaults: {appName: session.appName, userId: session.userId, state: {}},
    });

    if (event.actions && event.actions.stateDelta) {
      const appDelta: Record<string, unknown> = {};
      const userDelta: Record<string, unknown> = {};
      const sessionDelta: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(event.actions.stateDelta)) {
        if (key.startsWith(State.TEMP_PREFIX)) continue;

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
        await appStateModel.save();
      }
      if (Object.keys(userDelta).length > 0) {
        userStateModel.state = {...userStateModel.state, ...userDelta};
        await userStateModel.save();
      }
      if (Object.keys(sessionDelta).length > 0) {
        storageSession.state = {...storageSession.state, ...sessionDelta};
        await storageSession.save();
      }
    }

    await StorageEvent.create({
      id: event.id,
      appName: session.appName,
      userId: session.userId,
      sessionId: session.id,
      invocationId: event.invocationId,
      timestamp: new Date(event.timestamp),
      eventData: event,
    });

    // Update session timestamp
    storageSession.changed('updateTime', true);
    await storageSession.save();

    const newMergedState = mergeStates(
      appStateModel.state,
      userStateModel.state,
      storageSession.state,
    );
    session.state = newMergedState;
    session.events.push(event);
    session.lastUpdateTime = storageSession.updateTime
      ? storageSession.updateTime.getTime()
      : Date.now();

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
