/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EntityClass,
  EntityManager,
  FilterQuery,
  LockMode as LockModeEnum,
  MikroORM as MikroORMClass,
  RequiredEntityData,
  UniqueConstraintViolationException as UniqueConstraintViolationExceptionClass,
} from '@mikro-orm/core';
import type {MikroORMOptions as MikroDBOptions} from './db/operations.js';

import {Event} from '../events/event.js';
import {newId} from '../utils/id_provider.js';
import {logger} from '../utils/logger.js';
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
  upsertSessionEvent,
} from './base_session_service.js';
import {createSession, Session} from './session.js';
import {StaleSessionError} from './stale_session_error.js';
import {State} from './state.js';

type SchemaModule = typeof import('./db/schema.js');
type OperationsModule = typeof import('./db/operations.js');
type StorageEventEntity = InstanceType<SchemaModule['StorageEvent']>;
type StorageSessionEntity = InstanceType<SchemaModule['StorageSession']>;

let MikroORM: typeof MikroORMClass;
let LockMode: typeof LockModeEnum;
let UniqueConstraintViolationException: typeof UniqueConstraintViolationExceptionClass;
let ENTITIES: SchemaModule['ENTITIES'];
let StorageAppState: SchemaModule['StorageAppState'];
let StorageEvent: SchemaModule['StorageEvent'];
let StorageSession: SchemaModule['StorageSession'];
let StorageUserState: SchemaModule['StorageUserState'];
let ensureDatabaseCreated: OperationsModule['ensureDatabaseCreated'];
let getConnectionOptionsFromUri: OperationsModule['getConnectionOptionsFromUri'];
let validateDatabaseSchemaVersion: OperationsModule['validateDatabaseSchemaVersion'];

let mikroOrmLoad: Promise<void> | undefined;

/**
 * Resolves (and memoizes) MikroORM plus the ADK database modules.
 *
 * These stay off the static import graph so that `@mikro-orm/core` is not
 * evaluated when an agent imports `@google/adk` and never opens a database.
 * A rejected promise stays cached, so a broken install keeps producing the
 * same error instead of retrying module resolution on every call.
 */
function loadMikroOrm(): Promise<void> {
  mikroOrmLoad ??= importMikroOrm();
  return mikroOrmLoad;
}

async function importMikroOrm(): Promise<void> {
  const [core, schema, operations] = await Promise.all([
    import('@mikro-orm/core'),
    import('./db/schema.js'),
    import('./db/operations.js'),
  ]);

  ({MikroORM, LockMode, UniqueConstraintViolationException} = core);
  ({ENTITIES, StorageAppState, StorageEvent, StorageSession, StorageUserState} =
    schema);
  ({
    ensureDatabaseCreated,
    getConnectionOptionsFromUri,
    validateDatabaseSchemaVersion,
  } = operations);
}

export {isStaleSessionError, StaleSessionError} from './stale_session_error.js';

const STORAGE_UPDATE_MARKER_SYMBOL = Symbol.for(
  'google.adk.session.storageUpdateMarker',
);

/**
 * The stored `update_time` that a session object was last synced with.
 *
 * `unverifiedWrite` is true when the value came from a write this service made,
 * not from a read. The database can round such a value after the write.
 *
 * `eventsComplete` is true when `session.events` holds every stored event of
 * the session, and false when it can hold only the most recent events.
 *
 * `totalEventCount` is the total number of stored events for this session at the
 * time the marker was recorded, when known.
 */
interface StorageRevisionRecord {
  marker: string;
  recordedLastUpdateTime: number;
  unverifiedWrite: boolean;
  eventsComplete: boolean;
  totalEventCount?: number;
}

function setStorageRevisionMarker(
  session: Session,
  revision: StorageRevisionRecord,
): void {
  Object.defineProperty(session, STORAGE_UPDATE_MARKER_SYMBOL, {
    value: revision,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function getStorageRevisionMarker(
  session: Session,
): StorageRevisionRecord | undefined {
  return (session as {[STORAGE_UPDATE_MARKER_SYMBOL]?: StorageRevisionRecord})[
    STORAGE_UPDATE_MARKER_SYMBOL
  ];
}

/**
 * Maximum number of IDs to include in a single SQL `$nin` filter query.
 * Keeps the parameter count safely below driver bind-parameter limits.
 */
const MAX_IN_QUERY_IDS = 500;

/**
 * Returns true when storage holds no event that the session object does not
 * know, and the newest stored event is the last event of the session object.
 *
 * When `eventsComplete` is false, the session object can hold only its most
 * recent events. Then only stored events at or after the timestamp of its first
 * event count as unknown.
 *
 * When `totalEventCount` is provided, storage must hold exactly that many
 * events for the session.
 */
async function sessionMatchesStorageRevision(
  txEm: EntityManager,
  session: Session,
  eventsComplete: boolean,
  totalEventCount?: number,
): Promise<boolean> {
  const sessionWhere = {
    appName: session.appName,
    userId: session.userId,
    sessionId: session.id,
  };
  const latestStorageEvent = await txEm.findOne(StorageEvent, sessionWhere, {
    orderBy: {timestamp: 'DESC', id: 'DESC'},
  });
  if (session.events.length === 0) {
    if (latestStorageEvent !== null) {
      return false;
    }
    if (totalEventCount !== undefined && totalEventCount !== 0) {
      return false;
    }
    return true;
  }
  if (latestStorageEvent?.id !== session.events[session.events.length - 1].id) {
    return false;
  }
  if (totalEventCount !== undefined) {
    const totalStored = await txEm.count(StorageEvent, sessionWhere);
    if (totalStored !== totalEventCount) {
      return false;
    }
  }

  const knownIds = session.events.map((e) => e.id);
  if (knownIds.length <= MAX_IN_QUERY_IDS) {
    const unknownEventWhere: FilterQuery<StorageEventEntity> = {
      ...sessionWhere,
      id: {$nin: knownIds},
    };
    if (!eventsComplete) {
      unknownEventWhere.timestamp = {
        $gte: new Date(session.events[0].timestamp),
      };
    }
    return (await txEm.count(StorageEvent, unknownEventWhere)) === 0;
  }

  const filter: FilterQuery<StorageEventEntity> = {...sessionWhere};
  if (!eventsComplete) {
    filter.timestamp = {$gte: new Date(session.events[0].timestamp)};
  }
  const storedEvents = await txEm.find(StorageEvent, filter, {
    fields: ['id'],
  });
  const knownSet = new Set(knownIds);
  for (const stored of storedEvents) {
    if (!knownSet.has(stored.id)) {
      return false;
    }
  }
  return true;
}

/**
 * Formats a Date or timestamp into 'YYYY-MM-DD HH:mm:ss.sss' in UTC.
 */
function formatDateTime(dateOrEpochMs: Date | number): string {
  const date =
    typeof dateOrEpochMs === 'number' ? new Date(dateOrEpochMs) : dateOrEpochMs;
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

interface SplitStateDelta {
  appDelta: Record<string, unknown>;
  userDelta: Record<string, unknown>;
  sessionDelta: Record<string, unknown>;
  hasAppDelta: boolean;
  hasUserDelta: boolean;
  hasSessionDelta: boolean;
}

function splitStateDelta(state?: Record<string, unknown>): SplitStateDelta {
  const appDelta: Record<string, unknown> = {};
  const userDelta: Record<string, unknown> = {};
  const sessionDelta: Record<string, unknown> = {};

  if (state) {
    for (const [key, value] of Object.entries(state)) {
      if (key.startsWith(State.APP_PREFIX)) {
        appDelta[key.slice(State.APP_PREFIX.length)] = value;
      } else if (key.startsWith(State.USER_PREFIX)) {
        userDelta[key.slice(State.USER_PREFIX.length)] = value;
      } else if (!key.startsWith(State.TEMP_PREFIX)) {
        sessionDelta[key] = value;
      }
    }
  }

  return {
    appDelta,
    userDelta,
    sessionDelta,
    hasAppDelta: Object.keys(appDelta).length > 0,
    hasUserDelta: Object.keys(userDelta).length > 0,
    hasSessionDelta: Object.keys(sessionDelta).length > 0,
  };
}

/**
 * Loads a shared state row or inserts one inside a savepoint so a concurrent
 * insert collision does not abort the outer transaction.
 *
 * When `lockForUpdate` is true, an existing row is locked with
 * `LockMode.PESSIMISTIC_WRITE` so concurrent writers serialize before merging
 * their JSON state delta. When `avoidGapLock` is true (such as `createSession`,
 * where the row may not exist yet), existence is checked without a lock first
 * so MySQL/InnoDB does not take a gap lock on a missing key and deadlock
 * concurrent first inserts.
 */
async function getOrCreateStateRow<T extends object>(
  txEm: EntityManager,
  entityClass: EntityClass<T>,
  where: FilterQuery<NoInfer<T>>,
  createData: RequiredEntityData<T>,
  options: {lockForUpdate: boolean; avoidGapLock: boolean},
): Promise<T> {
  const {lockForUpdate, avoidGapLock} = options;

  let row: T | null;
  if (lockForUpdate && !avoidGapLock) {
    row = await txEm.findOne(entityClass, where, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
  } else {
    row = await txEm.findOne(entityClass, where);
    if (row && lockForUpdate) {
      row = await txEm.findOne(entityClass, where, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        refresh: true,
      });
    }
  }

  if (row) {
    return row;
  }

  try {
    return await txEm.transactional(
      async (savepointEm) => {
        const created = savepointEm.create(entityClass, createData);
        savepointEm.persist(created);
        return created;
      },
      {clear: true},
    );
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) {
      throw error;
    }
    // A concurrent transaction inserted the row first. Use a locking read
    // (`FOR UPDATE` when mutating, `FOR SHARE` otherwise) so MVCC dialects
    // such as MySQL REPEATABLE READ also observe the newly committed row.
    const raced = await txEm.findOne(entityClass, where, {
      lockMode: lockForUpdate
        ? LockMode.PESSIMISTIC_WRITE
        : LockMode.PESSIMISTIC_READ,
      refresh: true,
    });
    if (!raced) {
      throw error;
    }
    return raced;
  }
}

/**
 * Options for configuring {@link DatabaseSessionService}.
 */
export interface DatabaseSessionServiceOptions extends MikroDBOptions {
  /**
   * How to handle stale sessions in {@link DatabaseSessionService.appendEvent}.
   *
   * - `'reject'` (default): throws a {@link StaleSessionError} without persisting changes.
   * - `'reload'`: reloads stored events and state into the session object after writing.
   *
   * @deprecated 'reload' is deprecated and will be removed in a future release. Use 'reject' (the default) and re-read the session with `getSession` to retry.
   */
  staleSession?: 'reject' | 'reload';
}

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
  private orm?: MikroORMClass;
  private initialized = false;
  private options?: MikroDBOptions;
  private connectionString?: string;
  private readonly staleSession: 'reject' | 'reload';

  constructor(
    connectionStringOrOptions: DatabaseSessionServiceOptions | string,
    options?: DatabaseSessionServiceOptions,
  ) {
    super();
    if (typeof connectionStringOrOptions === 'string') {
      this.connectionString = connectionStringOrOptions;
      if (options) {
        const {staleSession, ...mikroOptions} = options;
        this.options = mikroOptions;
        this.staleSession = staleSession ?? 'reject';
      } else {
        this.staleSession = 'reject';
      }
    } else {
      const {staleSession: firstStaleSession, ...firstMikroOptions} =
        connectionStringOrOptions;
      const {staleSession: secondStaleSession, ...secondMikroOptions} =
        options ?? {};
      const mergedMikroOptions = {
        ...firstMikroOptions,
        ...secondMikroOptions,
      };
      if (!mergedMikroOptions.driver) {
        throw new Error('Driver is required when passing options object.');
      }

      this.options = mergedMikroOptions;
      this.staleSession = secondStaleSession ?? firstStaleSession ?? 'reject';
    }
  }

  async init() {
    if (this.initialized) {
      return;
    }

    await loadMikroOrm();

    // ENTITIES overrides a caller-supplied `entities`, exactly as the
    // constructor did before the schema module became lazy.
    const options: MikroDBOptions = this.connectionString
      ? {
          ...(await getConnectionOptionsFromUri(this.connectionString)),
          ...this.options,
          entities: ENTITIES,
        }
      : {...this.options, entities: ENTITIES};
    this.options = options;

    this.orm = await MikroORM.init(options);
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

    const id = sessionId || newId();
    const now = new Date();
    const {appDelta, userDelta, sessionDelta, hasAppDelta, hasUserDelta} =
      splitStateDelta(state);

    return em.transactional(async (txEm) => {
      const existing = await txEm.findOne(StorageSession, {
        id,
        appName,
        userId,
      });
      if (existing) {
        throw new Error(`Session with id ${id} already exists.`);
      }

      // Lock order matches appendEvent (app_states before user_states) so
      // concurrent createSession and appendEvent transactions cannot deadlock.
      const appStateModel = await getOrCreateStateRow(
        txEm,
        StorageAppState,
        {appName},
        {appName, state: {}, updateTime: now},
        {lockForUpdate: hasAppDelta, avoidGapLock: true},
      );

      const userStateModel = await getOrCreateStateRow(
        txEm,
        StorageUserState,
        {appName, userId},
        {appName, userId, state: {}},
        {lockForUpdate: hasUserDelta, avoidGapLock: true},
      );

      const modelsToPersist: object[] = [];
      if (hasAppDelta) {
        appStateModel.state = {...appStateModel.state, ...appDelta};
        modelsToPersist.push(appStateModel);
      }
      if (hasUserDelta) {
        userStateModel.state = {...userStateModel.state, ...userDelta};
        modelsToPersist.push(userStateModel);
      }

      const storageSession = txEm.create(StorageSession, {
        id,
        appName,
        userId,
        state: sessionDelta,
        createTime: now,
        updateTime: now,
      });
      modelsToPersist.push(storageSession);
      txEm.persist(modelsToPersist);

      const mergedState = mergeStates(
        appStateModel.state,
        userStateModel.state,
        sessionDelta,
      );

      const session = createSession({
        id,
        appName,
        userId,
        state: mergedState,
        events: [],
        lastUpdateTime: storageSession.updateTime.getTime(),
      });
      setStorageRevisionMarker(session, {
        marker: storageSession.updateTime.toISOString(),
        recordedLastUpdateTime: session.lastUpdateTime,
        unverifiedWrite: true,
        eventsComplete: true,
        totalEventCount: 0,
      });
      return session;
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

    const eventWhere: FilterQuery<StorageEventEntity> = {
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

    const session = createSession({
      id: sessionId,
      appName,
      userId,
      state: mergedState,
      events: storageEvents.map((se) => se.eventData),
      lastUpdateTime: storageSession.updateTime.getTime(),
    });
    const eventsComplete =
      config?.numRecentEvents === undefined &&
      config?.afterTimestamp === undefined;
    const totalEventCount = eventsComplete
      ? session.events.length
      : await em.count(StorageEvent, {appName, userId, sessionId});

    setStorageRevisionMarker(session, {
      marker: storageSession.updateTime.toISOString(),
      recordedLastUpdateTime: session.lastUpdateTime,
      unverifiedWrite: false,
      eventsComplete,
      totalEventCount,
    });
    return session;
  }

  async listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    await this.init();
    const em = this.orm!.em.fork();

    const where: FilterQuery<StorageSessionEntity> = {appName};
    if (userId !== undefined) {
      where.userId = userId;
    }

    const orderBy =
      order === 'asc'
        ? {updateTime: 'ASC' as const, id: 'ASC' as const}
        : order === 'desc'
          ? {updateTime: 'DESC' as const, id: 'ASC' as const}
          : undefined;

    let storageSessions;
    let paginationMeta: Pick<
      ListSessionsResponse,
      'page' | 'limit' | 'totalItems' | 'totalPages'
    >;

    if (limit !== undefined) {
      const totalItems = await em.count(StorageSession, where);
      const totalPages = limit === 0 ? 0 : Math.ceil(totalItems / limit);

      let effectiveOffset: number;
      let effectivePage: number;
      if (page !== undefined) {
        effectiveOffset = (page - 1) * limit;
        effectivePage = page;
      } else {
        effectiveOffset = offset ?? 0;
        effectivePage =
          limit === 0 ? 1 : Math.floor(effectiveOffset / limit) + 1;
      }

      storageSessions = await em.find(StorageSession, where, {
        orderBy,
        limit,
        offset: effectiveOffset,
      });
      paginationMeta = {page: effectivePage, limit, totalItems, totalPages};
    } else if (offset) {
      const totalItems = await em.count(StorageSession, where);
      storageSessions = await em.find(StorageSession, where, {
        orderBy,
        offset,
      });
      paginationMeta = {
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      };
    } else {
      storageSessions = await em.find(StorageSession, where, {orderBy});
      const totalItems = storageSessions.length;
      paginationMeta = {
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      };
    }

    const appStateModel = await em.findOne(StorageAppState, {appName});
    const appState = appStateModel?.state || {};
    const userStateMap: Record<string, Record<string, unknown>> = {};

    if (userId !== undefined) {
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
      const session = createSession({
        id: ss.id,
        appName: ss.appName,
        userId: ss.userId,
        state: merged,
        events: [],
        lastUpdateTime: ss.updateTime.getTime(),
      });
      setStorageRevisionMarker(session, {
        marker: ss.updateTime.toISOString(),
        recordedLastUpdateTime: session.lastUpdateTime,
        unverifiedWrite: false,
        eventsComplete: false,
      });
      return session;
    });

    return {sessions, ...paginationMeta};
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

    const stateDelta = event.actions?.stateDelta ?? {};
    const {
      appDelta,
      userDelta,
      sessionDelta,
      hasAppDelta,
      hasUserDelta,
      hasSessionDelta,
    } = splitStateDelta(stateDelta);
    const trimmedEvent = trimTempDeltaState(event);
    let sessionWasStale = false;

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

      const storageUpdateTime = storageSession.updateTime.getTime();
      const storageUpdateMarker = storageSession.updateTime.toISOString();
      const rev = getStorageRevisionMarker(session);
      const callerMutatedLastUpdateTime =
        rev !== undefined &&
        rev.recordedLastUpdateTime !== session.lastUpdateTime;
      let isStale = false;

      if (rev !== undefined && !callerMutatedLastUpdateTime) {
        if (rev.marker === storageUpdateMarker) {
          session.lastUpdateTime = storageUpdateTime;
        } else if (
          rev.unverifiedWrite &&
          storageUpdateTime % 1000 === 0 &&
          Math.abs(storageUpdateTime - rev.recordedLastUpdateTime) < 1000 &&
          (await sessionMatchesStorageRevision(
            txEm,
            session,
            rev.eventsComplete,
            rev.totalEventCount,
          ))
        ) {
          session.lastUpdateTime = storageUpdateTime;
        } else {
          isStale = true;
        }
      } else if (rev !== undefined) {
        isStale = storageUpdateTime > session.lastUpdateTime;
      } else if (storageUpdateTime > session.lastUpdateTime) {
        if (await sessionMatchesStorageRevision(txEm, session, false)) {
          session.lastUpdateTime = storageUpdateTime;
        } else {
          isStale = true;
        }
      }

      if (isStale) {
        if (this.staleSession === 'reject') {
          const message =
            storageUpdateTime > session.lastUpdateTime
              ? `The last_update_time provided in the session object ${formatDateTime(session.lastUpdateTime)} is earlier than the update_time in the storage_session ${formatDateTime(storageSession.updateTime)}. Please check if it is a stale session.`
              : `The session object with last_update_time ${formatDateTime(session.lastUpdateTime)} does not match the storage_session revision with update_time ${formatDateTime(storageSession.updateTime)}. Please check if it is a stale session.`;
          throw new StaleSessionError(message);
        }
        sessionWasStale = true;
      }

      // Lock order: StorageSession -> StorageAppState -> StorageUserState.
      // Only lock shared rows that this event mutates so concurrent turns that
      // only touch session state do not serialize on app_states or user_states.
      const appStateModel = await getOrCreateStateRow(
        txEm,
        StorageAppState,
        {appName: session.appName},
        {appName: session.appName, state: {}, updateTime: new Date()},
        {lockForUpdate: hasAppDelta, avoidGapLock: false},
      );

      const userStateModel = await getOrCreateStateRow(
        txEm,
        StorageUserState,
        {appName: session.appName, userId: session.userId},
        {appName: session.appName, userId: session.userId, state: {}},
        {lockForUpdate: hasUserDelta, avoidGapLock: false},
      );

      const modelsToPersist: object[] = [storageSession];
      if (hasAppDelta) {
        appStateModel.state = {...appStateModel.state, ...appDelta};
        modelsToPersist.push(appStateModel);
      }
      if (hasUserDelta) {
        userStateModel.state = {...userStateModel.state, ...userDelta};
        modelsToPersist.push(userStateModel);
      }
      if (hasSessionDelta) {
        storageSession.state = {...storageSession.state, ...sessionDelta};
      }

      const existingStorageEvent = await txEm.findOne(StorageEvent, {
        id: trimmedEvent.id,
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      });

      if (existingStorageEvent) {
        existingStorageEvent.eventData = trimmedEvent;
        existingStorageEvent.timestamp = new Date(trimmedEvent.timestamp);
        txEm.persist(existingStorageEvent);
      } else {
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
      }

      storageSession.updateTime = new Date(event.timestamp);

      // `em.transactional` owns the single commit for this block, so every
      // mutation has to be staged before the callback returns. MikroORM v7 no
      // longer picks up scalar and JSON mutations on its own either, so each
      // model edited above is persisted explicitly.
      txEm.persist(modelsToPersist);

      const newMergedState = mergeStates(
        appStateModel.state,
        userStateModel.state,
        storageSession.state,
      );
      // temp: keys are never stored, but stay in the in-memory session for the
      // rest of the invocation: carry over earlier ones, then this event's
      for (const source of [session.state, stateDelta]) {
        for (const [key, value] of Object.entries(source)) {
          if (key.startsWith(State.TEMP_PREFIX)) {
            newMergedState[key] = value;
          }
        }
      }
      session.state = newMergedState;

      const isNewEvent = !existingStorageEvent;
      upsertSessionEvent(session, event);
      session.lastUpdateTime = storageSession.updateTime.getTime();

      let nextTotalEventCount: number | undefined;
      if (!callerMutatedLastUpdateTime && !isStale) {
        if (rev?.totalEventCount !== undefined) {
          nextTotalEventCount = rev.totalEventCount + (isNewEvent ? 1 : 0);
        } else if (rev?.eventsComplete === true) {
          nextTotalEventCount = session.events.length;
        }
      }

      setStorageRevisionMarker(session, {
        marker: storageSession.updateTime.toISOString(),
        recordedLastUpdateTime: session.lastUpdateTime,
        unverifiedWrite: true,
        eventsComplete:
          !callerMutatedLastUpdateTime &&
          rev?.eventsComplete === true &&
          !isStale,
        totalEventCount: nextTotalEventCount,
      });
    });

    if (sessionWasStale) {
      try {
        const storageEvents = await em.find(
          StorageEvent,
          {
            appName: session.appName,
            userId: session.userId,
            sessionId: session.id,
          },
          {orderBy: {timestamp: 'ASC'}},
        );
        session.events = storageEvents.map((se) => se.eventData);
        upsertSessionEvent(session, event);
        const lastRev = getStorageRevisionMarker(session);
        if (lastRev) {
          setStorageRevisionMarker(session, {
            ...lastRev,
            eventsComplete: true,
            totalEventCount: session.events.length,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn(
          `Failed to reload events for stale session ${session.id} after ` +
            `appendEvent; the event was persisted but session.events may be ` +
            `missing concurrent appends: ${message}`,
        );
      }
    }

    return event;
  }
}
