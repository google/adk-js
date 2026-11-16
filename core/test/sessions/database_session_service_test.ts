/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  createSession,
  DatabaseSessionService,
  Event,
  isStaleSessionError,
  StaleSessionError,
  State,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {isDatabaseConnectionString} from '../../src/sessions/database_session_service.js';
import {validateDatabaseSchemaVersion} from '../../src/sessions/db/operations.js';
import {
  StorageEvent,
  StorageMetadata,
  StorageSession,
} from '../../src/sessions/db/schema.js';

describe('DatabaseSessionService', () => {
  let service: DatabaseSessionService;

  beforeEach(async () => {
    service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true, // simplified for tests
    });
    await service.init();
  });

  afterEach(async () => {
    // MikroORM closing
    const orm = (service as unknown as {orm: MikroORM}).orm;
    if (orm) {
      await orm.close();
    }
  });

  it('should create a session', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      state: {'foo': 'bar'},
      sessionId: 'test-session-id',
    });

    expect(session.id).toBe('test-session-id');
    expect(session.appName).toBe('test-app');
    expect(session.userId).toBe('test-user');
    expect(session.state['foo']).toBe('bar');
  });

  it('should filter out temporary state keys prefixed with temp: on creation', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      state: {
        'foo': 'bar',
        [`${State.TEMP_PREFIX}temp`]: 'value',
      },
      sessionId: 'test-session-id-2',
    });

    expect(session.id).toBe('test-session-id-2');
    expect(session.state['foo']).toBe('bar');
    expect(session.state[`${State.TEMP_PREFIX}temp`]).toBeUndefined();
  });

  it('should get a session', async () => {
    const beforeCreate = Date.now();
    const created = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session-id',
      state: {'key': 'value'},
    });
    expect(created.lastUpdateTime).toBeGreaterThanOrEqual(beforeCreate);
    expect(created.lastUpdateTime).toBeLessThanOrEqual(Date.now());

    const session = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session-id',
    });

    expect(session).toBeDefined();
    expect(session?.id).toBe('test-session-id');
    expect(session?.state['key']).toBe('value');
    expect(session?.lastUpdateTime).toBeGreaterThanOrEqual(beforeCreate);
    expect(session?.lastUpdateTime).toBeLessThanOrEqual(Date.now());
  });

  it('isolates session events across users sharing the same sessionId', async () => {
    const appName = 'my_app';
    const sessionId = 'session11';
    const user1Session = await service.createSession({
      appName,
      userId: 'user1',
      sessionId,
      state: {key11: 'value11'},
    });
    await service.createSession({
      appName,
      userId: 'malicious',
      sessionId,
    });

    await service.appendEvent({
      session: user1Session,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        timestamp: Date.now(),
        content: {role: 'user', parts: [{text: 'text'}]},
      }),
    });

    const ownerSession = await service.getSession({
      appName,
      userId: 'user1',
      sessionId,
    });
    expect(ownerSession?.events).toHaveLength(1);

    const otherUserSession = await service.getSession({
      appName,
      userId: 'malicious',
      sessionId,
    });
    expect(otherUserSession).toBeDefined();
    expect(otherUserSession?.events).toHaveLength(0);
  });

  it('should list sessions', async () => {
    await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });
    await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's2',
    });

    const response = await service.listSessions({
      appName: 'test-app',
      userId: 'test-user',
    });

    expect(response.sessions.length).toBe(2);
    const ids = response.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['s1', 's2']);
  });

  it('should delete a session', async () => {
    await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });

    await service.deleteSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });

    const session = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });

    expect(session).toBeUndefined();
  });

  it('should append event and update state', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
      state: {'count': 0},
    });

    const event: Event = createEvent({
      timestamp: Date.now(),
      actions: {
        stateDelta: {'count': 1, [State.APP_PREFIX + 'global']: 'value'},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
    });

    await service.appendEvent({session, event});

    expect(session.state['count']).toBe(1);
    expect(session.state[State.APP_PREFIX + 'global']).toBe('value');

    // Verify persistence
    const loadedSession = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 's1',
    });

    expect(loadedSession?.state['count']).toBe(1);
    expect(loadedSession?.state[State.APP_PREFIX + 'global']).toBe('value');
    expect(loadedSession?.events.length).toBe(1);
  });

  it('should persist app state across sessions', async () => {
    // Create first session and update app state
    await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      state: {[State.APP_PREFIX + 'config']: 'dark-mode'},
    });

    // Create second session for same app but different user
    const s2 = await service.createSession({
      appName: 'test-app',
      userId: 'user2',
      sessionId: 's2',
    });

    expect(s2.state[State.APP_PREFIX + 'config']).toBe('dark-mode');

    // Update app state in s2 via appendEvent
    const event = createEvent({
      timestamp: Date.now(),
      actions: createEventActions({
        stateDelta: {[State.APP_PREFIX + 'config']: 'light-mode'},
      }),
    });
    await service.appendEvent({session: s2, event});

    // Verify s1 sees the update when re-fetched
    const s1Reloaded = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });
    expect(s1Reloaded?.state[State.APP_PREFIX + 'config']).toBe('light-mode');
  });

  it('should persist user state across sessions', async () => {
    // Session 1 for user1
    await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      state: {[State.USER_PREFIX + 'pref']: 'A'},
    });

    // Session 2 for same user
    const s2 = await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's2',
    });

    expect(s2.state[State.USER_PREFIX + 'pref']).toBe('A');

    // Update user state in s2
    const event = createEvent({
      timestamp: Date.now(),
      actions: createEventActions({
        stateDelta: {[State.USER_PREFIX + 'pref']: 'B'},
      }),
    });
    await service.appendEvent({session: s2, event});

    // Verify s1 sees update
    const s1Reloaded = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });
    expect(s1Reloaded?.state[State.USER_PREFIX + 'pref']).toBe('B');

    // Verify another user doesn't see it
    const s3 = await service.createSession({
      appName: 'test-app',
      userId: 'user2',
      sessionId: 's3',
    });
    expect(s3.state[State.USER_PREFIX + 'pref']).toBeUndefined();
  });

  it('should filter events in getSession', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });

    const now = Date.now();
    const e1 = createEvent({timestamp: now - 1000});
    const e2 = createEvent({timestamp: now});
    const e3 = createEvent({timestamp: now + 1000});

    await service.appendEvent({session, event: e1});
    await service.appendEvent({session, event: e2});
    await service.appendEvent({session, event: e3});

    // Test numRecentEvents
    const recent = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      config: {numRecentEvents: 2},
    });
    expect(recent?.events.length).toBe(2);
    expect(recent?.events[0].id).toBe(e2.id);
    expect(recent?.events[1].id).toBe(e3.id);

    // Test afterTimestamp
    const after = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      config: {afterTimestamp: now - 100},
    });
    expect(after?.events.length).toBe(2);
    expect(after?.events[0].id).toBe(e2.id);
    expect(after?.events[1].id).toBe(e3.id);

    // Test afterTimestamp
    const after2 = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
      config: {afterTimestamp: now},
    });
    expect(after2?.events.length).toBe(1);
    expect(after2?.events[0].id).toBe(e3.id);
  });

  it('should refresh events on a stale session object in appendEvent when configured with staleSession reload', async () => {
    const reloadService = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
      staleSession: 'reload',
    });
    await reloadService.init();

    try {
      const session = await reloadService.createSession({
        appName: 'test-app',
        userId: 'user1',
        sessionId: 's1',
      });

      // A second handle on the same session appends an event, making the
      // first handle stale.
      const otherHandle = await reloadService.getSession({
        appName: 'test-app',
        userId: 'user1',
        sessionId: 's1',
      });
      const now = Date.now();
      const concurrentEvent = createEvent({timestamp: now + 10});
      await reloadService.appendEvent({
        session: otherHandle!,
        event: concurrentEvent,
      });

      // Older than the concurrent event: this is the contended case, where the
      // caller built its event and then waited on the row lock while another
      // handle committed. Reloading after the commit sorts the caller's event
      // into its timestamp position instead of appending it at the tail.
      const ownEvent = createEvent({timestamp: now + 5});
      await reloadService.appendEvent({session, event: ownEvent});

      // The stale handle must see both events in timestamp order, without
      // duplicates, and keep its own event object.
      expect(session.events.map((e) => e.id)).toEqual([
        ownEvent.id,
        concurrentEvent.id,
      ]);
      expect(session.events[0]).toBe(ownEvent);
    } finally {
      const orm = (reloadService as unknown as {orm: MikroORM}).orm;
      if (orm) {
        await orm.close();
      }
    }
  });

  it('should keep a stale session usable when the event reload fails', async () => {
    const reloadService = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
      staleSession: 'reload',
    });
    await reloadService.init();

    try {
      const session = await reloadService.createSession({
        appName: 'test-app',
        userId: 'user1',
        sessionId: 's1',
      });

      const otherHandle = await reloadService.getSession({
        appName: 'test-app',
        userId: 'user1',
        sessionId: 's1',
      });
      const now = Date.now();
      await reloadService.appendEvent({
        session: otherHandle!,
        event: createEvent({timestamp: now + 10}),
      });

      const orm = (reloadService as unknown as {orm: MikroORM}).orm;
      const fork = orm.em.fork.bind(orm.em);
      vi.spyOn(orm.em, 'fork').mockImplementation((...args) => {
        const em = fork(...args);
        vi.spyOn(em, 'find').mockRejectedValue(new Error('reload failed'));
        return em;
      });

      const ownEvent = createEvent({timestamp: now + 20});
      await expect(
        reloadService.appendEvent({session, event: ownEvent}),
      ).resolves.toBe(ownEvent);

      vi.restoreAllMocks();

      // The append committed even though the in-memory reload could not run.
      const reloaded = await reloadService.getSession({
        appName: 'test-app',
        userId: 'user1',
        sessionId: 's1',
      });
      expect(reloaded?.events.map((e) => e.id)).toContain(ownEvent.id);
    } finally {
      const orm = (reloadService as unknown as {orm: MikroORM}).orm;
      if (orm) {
        await orm.close();
      }
    }
  });

  it('should reject a stale session object in appendEvent by default', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });

    const otherHandle = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });
    const now = Date.now();
    const concurrentEvent = createEvent({timestamp: now + 10});
    await service.appendEvent({session: otherHandle!, event: concurrentEvent});

    const ownEvent = createEvent({
      timestamp: now + 5,
      actions: createEventActions({stateDelta: {key: 'value'}}),
    });
    await expect(
      service.appendEvent({session, event: ownEvent}),
    ).rejects.toThrow(StaleSessionError);

    // Verify type guard and message
    try {
      await service.appendEvent({session, event: ownEvent});
      expect.fail('Expected StaleSessionError to be thrown');
    } catch (e: unknown) {
      expect(isStaleSessionError(e)).toBe(true);
      expect((e as Error).message).toMatch(
        /is earlier than the update_time in the storage_session/,
      );
    }

    // Verify session in memory was not modified
    expect(session.events).toHaveLength(0);
    expect(session.state['key']).toBeUndefined();

    // Verify storage was not modified by the failed append
    const stored = await service.getSession({
      appName: 'test-app',
      userId: 'user1',
      sessionId: 's1',
    });
    expect(stored?.events.map((e) => e.id)).toEqual([concurrentEvent.id]);
    expect(stored?.state['key']).toBeUndefined();
  });

  it('should reject appending an event to a stale session after a concurrent update', async () => {
    const appName = 'my_app';
    const userId = 'user';
    const currentTime = Date.now();

    const originalSession = await service.createSession({
      appName,
      userId,
    });
    const event1 = createEvent({
      invocationId: 'inv1',
      author: 'user',
      timestamp: currentTime + 1000,
      actions: createEventActions({stateDelta: {sk1: 'v1'}}),
    });
    await service.appendEvent({session: originalSession, event: event1});

    const updatedSession = (await service.getSession({
      appName,
      userId,
      sessionId: originalSession.id,
    }))!;
    const event2 = createEvent({
      invocationId: 'inv2',
      author: 'user',
      timestamp: currentTime + 2000,
      actions: createEventActions({stateDelta: {sk2: 'v2'}}),
    });
    await service.appendEvent({session: updatedSession, event: event2});

    // originalSession is now stale
    expect(originalSession.lastUpdateTime).toBeLessThan(
      updatedSession.lastUpdateTime,
    );
    expect(originalSession.events.length).toBe(1);
    expect(originalSession.state['sk2']).toBeUndefined();

    // Appending another event to stale originalSession should be rejected.
    const event3 = createEvent({
      invocationId: 'inv3',
      author: 'user',
      timestamp: currentTime + 3000,
      actions: createEventActions({stateDelta: {sk3: 'v3'}}),
    });
    await expect(
      service.appendEvent({session: originalSession, event: event3}),
    ).rejects.toThrow(StaleSessionError);

    // If we fetch session from DB, it should only contain the committed events.
    const sessionFinal = (await service.getSession({
      appName,
      userId,
      sessionId: originalSession.id,
    }))!;
    expect(sessionFinal.events.length).toBe(2);
    expect(sessionFinal.state['sk1']).toBe('v1');
    expect(sessionFinal.state['sk2']).toBe('v2');
    expect(sessionFinal.state['sk3']).toBeUndefined();
    expect(sessionFinal.events.map((e) => e.invocationId)).toEqual([
      'inv1',
      'inv2',
    ]);
  });

  it('identifies StaleSessionError with isStaleSessionError', () => {
    const error = new StaleSessionError('stale');
    expect(isStaleSessionError(error)).toBe(true);
    expect(isStaleSessionError(new Error('other'))).toBe(false);
    expect(isStaleSessionError(null)).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
    expect(
      isStaleSessionError({
        [Symbol.for('google.adk.staleSessionError')]: true,
      }),
    ).toBe(true);
  });

  it('should filter sessions by userId in listSessions', async () => {
    await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });
    await service.createSession({
      appName: 'app1',
      userId: 'u2',
      sessionId: 's2',
    });
    await service.createSession({
      appName: 'app2', // Diff app
      userId: 'u1',
      sessionId: 's3',
    });

    const listU1 = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
    });
    expect(listU1.sessions.length).toBe(1);
    expect(listU1.sessions[0].id).toBe('s1');

    const listAll = await service.listSessions({
      appName: 'app1',
      userId: 'u1',
    });
    expect(listAll.sessions.length).toBe(1);
  });

  it.each([
    {options: {}, ids: ['empty-1', 'empty-2']},
    {options: {limit: 1}, ids: ['empty-1']},
    {options: {limit: 1, page: 2}, ids: ['empty-2']},
    {options: {limit: 1, offset: 1}, ids: ['empty-2']},
  ])(
    'filters an empty userId with options $options',
    async ({options, ids}) => {
      const appName = 'empty-user-app';
      const stateKey = State.USER_PREFIX + 'owner';
      await service.createSession({
        appName,
        userId: 'other-user',
        sessionId: 'other-session',
        state: {[stateKey]: 'other-user'},
      });
      const created = await service.createSession({
        appName,
        userId: '',
        sessionId: 'empty-1',
        state: {[stateKey]: 'empty-user'},
      });
      await service.createSession({appName, userId: '', sessionId: 'empty-2'});

      const loaded = await service.getSession({
        appName,
        userId: '',
        sessionId: created.id,
      });
      expect(loaded?.userId).toBe('');
      expect(loaded?.state[stateKey]).toBe('empty-user');

      const allUsers = await service.listSessions({appName});
      expect(allUsers.sessions.map((session) => session.id).sort()).toEqual([
        'empty-1',
        'empty-2',
        'other-session',
      ]);
      expect(allUsers.totalItems).toBe(3);
      expect(
        allUsers.sessions.find((session) => session.userId === 'other-user')
          ?.state[stateKey],
      ).toBe('other-user');

      const response = await service.listSessions({
        appName,
        userId: '',
        order: 'asc',
        ...options,
      });
      expect(response.totalItems).toBe(2);
      expect(
        response.sessions.map((session) => [
          session.id,
          session.userId,
          session.state[stateKey],
        ]),
      ).toEqual(ids.map((id) => [id, '', 'empty-user']));
    },
  );

  it('should handle errors', async () => {
    await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });

    // Test duplicate creation
    await expect(
      service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
      }),
    ).rejects.toThrow('Session with id s1 already exists');

    // Test requesting non-existent session
    const noSession = await service.getSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'ghost',
    });
    expect(noSession).toBeUndefined();

    // Test append to non-existent session
    const ghostSession = await service.createSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 'temp',
    });
    // Manually change ID to simulate object mismatch or stale ref
    ghostSession.id = 'missing';
    const event = createEvent();

    await expect(
      service.appendEvent({session: ghostSession, event}),
    ).rejects.toThrow('Session missing not found');
  });

  it('should fail with incompatible schema version', async () => {
    const internalService = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });
    await internalService.init();
    const orm = (internalService as unknown as {orm: MikroORM}).orm as MikroORM;

    // Manually insert bad version
    const em = orm.em.fork();
    await em.nativeDelete(StorageMetadata, {key: 'schema_version'});
    await em.insert(StorageMetadata, {
      key: 'schema_version',
      value: '999',
    });

    // Reuse the same ORM/DB connection if possible or create new one on same DB
    // With :memory:, each new ORM instance is a new DB unless we share the connection.
    // So we must reuse the service or simulate check on the same instance.
    // Re-check schema version
    await expect(validateDatabaseSchemaVersion(orm)).rejects.toThrow(
      'ADK Database schema version 999 is not compatible',
    );

    await orm.close();
  });

  it('preserves sub-second event timestamps, their order and afterTimestamp', async () => {
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'precision-session',
    });

    // All three land inside one wall-clock second, which is what a datetime
    // column with no fractional-seconds precision collapses onto one value.
    const second = Math.floor(Date.now() / 1000) * 1000;
    const timestamps = [second + 200, second + 400, second + 600];
    for (const [index, timestamp] of timestamps.entries()) {
      await service.appendEvent({
        session,
        event: createEvent({invocationId: `inv-${index}`, timestamp}),
      });
    }

    const loaded = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'precision-session',
    });

    expect(loaded?.events.map((event) => event.timestamp)).toEqual(timestamps);

    const afterFirst = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'precision-session',
      config: {afterTimestamp: second + 300},
    });

    expect(afterFirst?.events.map((event) => event.timestamp)).toEqual(
      timestamps.slice(1),
    );
  });

  describe('listSessions pagination and sorting', () => {
    const appName = 'test-app';
    const userId = 'test-user';

    it('no pagination params → returns all sessions with page=1', async () => {
      await service.createSession({appName, userId, sessionId: 's1'});
      await service.createSession({appName, userId, sessionId: 's2'});

      const response = await service.listSessions({appName, userId});

      expect(response.sessions).toHaveLength(2);
      expect(response.page).toBe(1);
      expect(response.limit).toBe(2);
      expect(response.totalItems).toBe(2);
      expect(response.totalPages).toBe(1);
    });

    it('order desc returns newest-first', async () => {
      const s1 = await service.createSession({
        appName,
        userId,
        sessionId: 's1',
      });
      const s2 = await service.createSession({
        appName,
        userId,
        sessionId: 's2',
      });
      const s3 = await service.createSession({
        appName,
        userId,
        sessionId: 's3',
      });
      await service.appendEvent({
        session: s1,
        event: createEvent({timestamp: 1000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 3000}),
      });
      await service.appendEvent({
        session: s3,
        event: createEvent({timestamp: 2000}),
      });

      const response = await service.listSessions({
        appName,
        userId,
        order: 'desc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
    });

    it('order asc returns oldest-first', async () => {
      const s1 = await service.createSession({
        appName,
        userId,
        sessionId: 's1',
      });
      const s2 = await service.createSession({
        appName,
        userId,
        sessionId: 's2',
      });
      const s3 = await service.createSession({
        appName,
        userId,
        sessionId: 's3',
      });
      await service.appendEvent({
        session: s1,
        event: createEvent({timestamp: 1000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 3000}),
      });
      await service.appendEvent({
        session: s3,
        event: createEvent({timestamp: 2000}),
      });

      const response = await service.listSessions({
        appName,
        userId,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s1', 's3', 's2']);
    });

    it('limit returns only N sessions with correct metadata', async () => {
      for (let i = 1; i <= 5; i++) {
        const s = await service.createSession({
          appName,
          userId,
          sessionId: `s${i}`,
        });
        await service.appendEvent({
          session: s,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const response = await service.listSessions({
        appName,
        userId,
        limit: 3,
        order: 'asc',
      });

      expect(response.sessions).toHaveLength(3);
      expect(response.totalItems).toBe(5);
      expect(response.totalPages).toBe(2);
      expect(response.limit).toBe(3);
    });

    it('page + limit returns correct slice', async () => {
      for (let i = 1; i <= 5; i++) {
        const s = await service.createSession({
          appName,
          userId,
          sessionId: `s${i}`,
        });
        await service.appendEvent({
          session: s,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const response = await service.listSessions({
        appName,
        userId,
        page: 2,
        limit: 2,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
      expect(response.page).toBe(2);
      expect(response.limit).toBe(2);
      expect(response.totalItems).toBe(5);
      expect(response.totalPages).toBe(3);
    });

    it('offset skips N sessions', async () => {
      for (let i = 1; i <= 4; i++) {
        const s = await service.createSession({
          appName,
          userId,
          sessionId: `s${i}`,
        });
        await service.appendEvent({
          session: s,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const response = await service.listSessions({
        appName,
        userId,
        limit: 2,
        offset: 2,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    });

    it('offset beyond total → empty sessions with correct metadata', async () => {
      await service.createSession({appName, userId, sessionId: 's1'});

      const response = await service.listSessions({
        appName,
        userId,
        limit: 2,
        offset: 10,
      });

      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(1);
      expect(response.totalPages).toBe(1);
    });

    it('limit=0 returns empty sessions and totalPages=0', async () => {
      await service.createSession({appName, userId, sessionId: 's1'});

      const response = await service.listSessions({appName, userId, limit: 0});

      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(1);
      expect(response.totalPages).toBe(0);
    });

    it('order without limit returns all sessions sorted with page=1', async () => {
      const s1 = await service.createSession({
        appName,
        userId,
        sessionId: 's1',
      });
      const s2 = await service.createSession({
        appName,
        userId,
        sessionId: 's2',
      });
      await service.appendEvent({
        session: s1,
        event: createEvent({timestamp: 2000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 1000}),
      });

      const response = await service.listSessions({
        appName,
        userId,
        order: 'desc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(response.page).toBe(1);
      expect(response.limit).toBe(2);
      expect(response.totalItems).toBe(2);
      expect(response.totalPages).toBe(1);
    });

    it('page takes precedence over offset when both are provided', async () => {
      for (let i = 1; i <= 5; i++) {
        const s = await service.createSession({
          appName,
          userId,
          sessionId: `s${i}`,
        });
        await service.appendEvent({
          session: s,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const response = await service.listSessions({
        appName,
        userId,
        page: 2,
        limit: 2,
        offset: 0,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
      expect(response.page).toBe(2);
    });
  });

  describe('Alignment Verification', () => {
    it('should trim temp state from event before persistence', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-temp',
      });

      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            'keep': 'me',
            [State.TEMP_PREFIX + 'hide']: 'me',
          },
        }),
      });

      await service.appendEvent({session, event});

      const em = (service as unknown as {orm: MikroORM}).orm.em.fork();
      const storedEvents = (await em.find(StorageEvent, {
        sessionId: 's-temp',
      })) as {sessionId: string; eventData: Event}[];
      const eventData = storedEvents[0].eventData;

      expect(eventData.actions?.stateDelta?.['keep']).toBe('me');
      expect(
        eventData.actions?.stateDelta?.[State.TEMP_PREFIX + 'hide'],
      ).toBeUndefined();
    });

    it('should keep temp state in the session for the invocation without storing it', async () => {
      const key = {appName: 'test-app', userId: 'test-user', sessionId: 's1'};
      const session = await service.createSession(key);
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {[State.TEMP_PREFIX + 'draft']: 'text', kept: 'value'},
        }),
      });

      await service.appendEvent({session, event});

      expect(session.state[State.TEMP_PREFIX + 'draft']).toBe('text');
      expect((await service.getSession(key))?.state).toEqual({kept: 'value'});
    });

    it('should keep temp state from an earlier event after a later append', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: {[State.TEMP_PREFIX + 'draft']: 'text'},
          }),
        }),
      });

      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now() + 1,
          actions: createEventActions({stateDelta: {kept: 'value'}}),
        }),
      });

      expect(session.state).toEqual({
        [State.TEMP_PREFIX + 'draft']: 'text',
        kept: 'value',
      });
    });

    it('should align session updateTime with event timestamp', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-time',
      });

      const timestamp = 1234567890000;
      const event = createEvent({timestamp});

      await service.appendEvent({session, event});

      expect(session.lastUpdateTime).toBe(timestamp);

      const em = (service as unknown as {orm: MikroORM}).orm.em.fork();
      const storedSession = (await em.findOne(StorageSession, {
        id: 's-time',
      })) as {id: string; updateTime: Date};

      expect(storedSession.updateTime.getTime()).toBe(timestamp);
    });
  });

  describe('appendEvent event payload persistence', () => {
    it('should preserve inlineData parts when appending and retrieving events', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-inline-data',
      });
      const inlinePart = {
        inlineData: {
          data: Buffer.from('test_image_data').toString('base64'),
          mimeType: 'image/png',
        },
      };
      const event = createEvent({
        invocationId: 'invocation',
        author: 'user',
        content: {
          role: 'user',
          parts: [inlinePart],
        },
      });

      await service.appendEvent({session, event});

      expect(session.events).toHaveLength(1);
      expect(session.events[0].content?.parts?.[0]).toEqual(inlinePart);

      const loadedSession = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: session.id,
      });
      expect(loadedSession?.events).toHaveLength(1);
      expect(loadedSession?.events[0].content?.parts?.[0]).toEqual(inlinePart);
    });

    it('should persist and restore event inlineData bytes and groundingMetadata sdkBlob', async () => {
      const session = await service.createSession({
        appName: 'my_app',
        userId: 'user',
      });
      const testContent = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: Buffer.from('test_image_data').toString('base64'),
              mimeType: 'image/png',
            },
          },
        ],
      };
      const testGroundingMetadata = {
        searchEntryPoint: {
          sdkBlob: Buffer.from('test_sdk_blob').toString('base64'),
        },
      };
      const event = createEvent({
        invocationId: 'invocation',
        author: 'user',
        content: testContent,
        groundingMetadata: testGroundingMetadata,
      });

      await service.appendEvent({session, event});

      expect(session.events[0].content).toEqual(testContent);

      const loadedSession = await service.getSession({
        appName: 'my_app',
        userId: 'user',
        sessionId: session.id,
      });
      const events = loadedSession?.events ?? [];
      expect(events).toHaveLength(1);
      expect(events[0].content).toEqual(testContent);
      expect(events[0].groundingMetadata).toEqual(testGroundingMetadata);
    });

    it('should persist and restore a complete event with all metadata and actions fields', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-complete-event',
      });
      const event = createEvent({
        invocationId: 'invocation',
        author: 'user',
        branch: 'main',
        content: {
          role: 'user',
          parts: [{text: 'test_text'}],
        },
        turnComplete: true,
        partial: false,
        actions: createEventActions({
          artifactDelta: {file: 0},
          transferToAgent: 'agent',
          escalate: true,
        }),
        longRunningToolIds: ['tool1'],
        errorCode: 'error_code',
        errorMessage: 'error_message',
        interrupted: true,
        groundingMetadata: {
          webSearchQueries: ['query1'],
        },
      });

      await service.appendEvent({session, event});

      const loadedSession = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: session.id,
      });

      expect(loadedSession?.events).toHaveLength(1);
      expect(loadedSession?.events[0]).toEqual(
        Object.fromEntries(Object.entries(event)),
      );
    });

    it('should skip persistence when appending a partial event with content', async () => {
      const session = await service.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 's-partial-event',
      });
      const event = createEvent({
        invocationId: 'invocation',
        author: 'model',
        content: {
          role: 'model',
          parts: [{text: 'partial_text'}],
        },
        partial: true,
      });

      await service.appendEvent({session, event});

      expect(session.events).toEqual([]);

      const loadedSession = await service.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: session.id,
      });
      expect(loadedSession?.events).toEqual([]);
    });
  });
});

describe('DatabaseSessionService entities', () => {
  let service: DatabaseSessionService;

  afterEach(async () => {
    await (service as unknown as {orm?: MikroORM}).orm?.close();
  });

  it('ignores a caller-supplied entities list', async () => {
    service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
      entities: [],
    });

    await service.init();
    const session = await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'entities-override',
    });

    expect(session.id).toBe('entities-override');
  });
});

describe('DatabaseSessionService stale-session reload', () => {
  const key = {appName: 'test-app', userId: 'test-user', sessionId: 's1'};
  let service: DatabaseSessionService;

  beforeEach(async () => {
    service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
      staleSession: 'reload',
    });
    await service.createSession({...key, state: {count: 0}});
  });

  afterEach(async () => {
    await (service as unknown as {orm?: MikroORM}).orm?.close();
  });

  it('reloads stored events and state into a stale copy before appending', async () => {
    const copyA = (await service.getSession(key))!;
    const copyB = (await service.getSession(key))!;

    const eventA = createEvent({
      timestamp: copyA.lastUpdateTime + 1000,
      actions: createEventActions({
        stateDelta: {
          count: 1,
          fromA: 'yes',
          [`${State.USER_PREFIX}pref`]: 'A',
          [`${State.APP_PREFIX}theme`]: 'dark',
        },
      }),
    });
    await service.appendEvent({session: copyA, event: eventA});

    const eventB = createEvent({
      timestamp: copyA.lastUpdateTime + 2000,
      actions: createEventActions({
        stateDelta: {
          count: 2,
          fromB: 'yes',
        },
      }),
    });
    await service.appendEvent({session: copyB, event: eventB});

    expect(copyB.events.map((event) => event.id)).toEqual([
      eventA.id,
      eventB.id,
    ]);
    expect(copyB.state['count']).toBe(2);
    expect(copyB.state['fromA']).toBe('yes');
    expect(copyB.state['fromB']).toBe('yes');
    expect(copyB.state[`${State.USER_PREFIX}pref`]).toBe('A');
    expect(copyB.state[`${State.APP_PREFIX}theme`]).toBe('dark');
    expect(copyB.lastUpdateTime).toBe(eventB.timestamp);

    const stored = (await service.getSession(key))!;
    expect(stored.events.map((event) => event.id)).toEqual([
      eventA.id,
      eventB.id,
    ]);
    expect(stored.state).toEqual(copyB.state);
  });
});

describe('DatabaseSessionService storage revision', () => {
  const key = {appName: 'test-app', userId: 'test-user', sessionId: 's1'};
  // A `.750` millisecond value is rounded up to the next whole second by a
  // `DATETIME(0)` column.
  const baseTime = Date.parse('2026-01-01T00:00:00.750Z');
  let service: DatabaseSessionService;

  async function setStoredUpdateTime(updateTime: number): Promise<void> {
    const em = (service as unknown as {orm: MikroORM}).orm.em.fork();
    await em.nativeUpdate(
      StorageSession,
      {appName: key.appName, userId: key.userId, id: key.sessionId},
      {updateTime: new Date(updateTime)},
    );
  }

  function roundToSecond(time: number): number {
    return Math.round(time / 1000) * 1000;
  }

  beforeEach(async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(baseTime);
    service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });
    await service.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await (service as unknown as {orm?: MikroORM}).orm?.close();
  });

  it('accepts the first append when storage rounds update_time up after createSession', async () => {
    const session = await service.createSession(key);
    expect(session.lastUpdateTime).toBe(baseTime);
    await setStoredUpdateTime(roundToSecond(session.lastUpdateTime));

    const event = createEvent({timestamp: baseTime + 500});
    await expect(service.appendEvent({session, event})).resolves.toBe(event);

    const stored = await service.getSession(key);
    expect(stored?.events.map((e) => e.id)).toEqual([event.id]);
  });

  it('accepts the next append when storage rounds update_time up after appendEvent', async () => {
    const session = await service.createSession(key);
    const first = createEvent({timestamp: baseTime + 1000});
    await service.appendEvent({session, event: first});
    expect(session.lastUpdateTime).toBe(baseTime + 1000);
    await setStoredUpdateTime(roundToSecond(session.lastUpdateTime));

    const second = createEvent({timestamp: baseTime + 1500});
    await expect(service.appendEvent({session, event: second})).resolves.toBe(
      second,
    );

    const stored = await service.getSession(key);
    expect(stored?.events.map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it('accepts a marker-less session whose events match storage after rounding', async () => {
    const created = await service.createSession(key);
    const first = createEvent({timestamp: baseTime + 1000});
    await service.appendEvent({session: created, event: first});
    await setStoredUpdateTime(roundToSecond(baseTime + 1000));

    const markerless = createSession({
      id: key.sessionId,
      appName: key.appName,
      userId: key.userId,
      events: [first],
      lastUpdateTime: baseTime + 1000,
    });
    const second = createEvent({timestamp: baseTime + 1500});
    await expect(
      service.appendEvent({session: markerless, event: second}),
    ).resolves.toBe(second);
    expect(markerless.lastUpdateTime).toBe(baseTime + 1500);
  });

  it('rejects a marker-less session whose events do not match storage', async () => {
    const created = await service.createSession(key);
    await service.appendEvent({
      session: created,
      event: createEvent({timestamp: baseTime + 1000}),
    });

    const markerless = createSession({
      id: key.sessionId,
      appName: key.appName,
      userId: key.userId,
      events: [],
      lastUpdateTime: baseTime,
    });
    await expect(
      service.appendEvent({
        session: markerless,
        event: createEvent({timestamp: baseTime + 1500}),
      }),
    ).rejects.toThrow(StaleSessionError);
  });

  it('rejects a concurrent append with an equal timestamp in the same rounded second', async () => {
    const session = await service.createSession(key);
    const otherHandle = (await service.getSession(key))!;
    const concurrentEvent = createEvent({timestamp: baseTime});
    await service.appendEvent({session: otherHandle, event: concurrentEvent});
    await setStoredUpdateTime(roundToSecond(baseTime));

    const ownEvent = createEvent({timestamp: baseTime + 100});
    await expect(
      service.appendEvent({session, event: ownEvent}),
    ).rejects.toThrow(
      /is earlier than the update_time in the storage_session 2026-01-01 00:00:01\.000/,
    );

    const stored = await service.getSession(key);
    expect(stored?.events.map((e) => e.id)).toEqual([concurrentEvent.id]);
  });

  it('rejects a concurrent append with an earlier timestamp', async () => {
    const session = await service.createSession(key);
    const otherHandle = (await service.getSession(key))!;
    const concurrentEvent = createEvent({timestamp: baseTime - 100});
    await service.appendEvent({session: otherHandle, event: concurrentEvent});

    const ownEvent = createEvent({timestamp: baseTime + 100});
    let thrown: unknown;
    try {
      await service.appendEvent({session, event: ownEvent});
    } catch (e: unknown) {
      thrown = e;
    }
    expect(isStaleSessionError(thrown)).toBe(true);
    const message = (thrown as Error).message;
    expect(message).toContain('2026-01-01 00:00:00.750');
    expect(message).toContain('2026-01-01 00:00:00.650');
    expect(message).toMatch(/does not match the storage_session revision/);

    expect(session.events).toHaveLength(0);
    const stored = await service.getSession(key);
    expect(stored?.events.map((e) => e.id)).toEqual([concurrentEvent.id]);
  });

  it('rejects a rounded session when a concurrent event has an earlier timestamp', async () => {
    const session = await service.createSession(key);
    const first = createEvent({timestamp: baseTime + 1000});
    await service.appendEvent({session, event: first});
    await setStoredUpdateTime(roundToSecond(first.timestamp));

    const otherHandle = (await service.getSession(key))!;
    const concurrentEvent = createEvent({timestamp: first.timestamp - 100});
    await service.appendEvent({session: otherHandle, event: concurrentEvent});
    await setStoredUpdateTime(roundToSecond(concurrentEvent.timestamp));

    await expect(
      service.appendEvent({
        session,
        event: createEvent({timestamp: baseTime + 1500}),
      }),
    ).rejects.toThrow(StaleSessionError);

    const stored = await service.getSession(key);
    expect(stored?.events.map((e) => e.id).sort()).toEqual(
      [first.id, concurrentEvent.id].sort(),
    );
  });

  it('rejects a rounded session when a concurrent event has the same timestamp and a smaller id', async () => {
    const session = await service.createSession(key);
    const first = createEvent({
      id: 'ffffffff-event',
      timestamp: baseTime + 1000,
    });
    await service.appendEvent({session, event: first});
    await setStoredUpdateTime(roundToSecond(first.timestamp));

    const otherHandle = (await service.getSession(key))!;
    const concurrentEvent = createEvent({
      id: '00000000-event',
      timestamp: first.timestamp,
    });
    expect(concurrentEvent.id < first.id).toBe(true);
    await service.appendEvent({session: otherHandle, event: concurrentEvent});
    await setStoredUpdateTime(roundToSecond(concurrentEvent.timestamp));

    await expect(
      service.appendEvent({
        session,
        event: createEvent({timestamp: baseTime + 1500}),
      }),
    ).rejects.toThrow(StaleSessionError);
  });

  it('accepts a rounded session loaded with numRecentEvents', async () => {
    const created = await service.createSession(key);
    const oldest = createEvent({timestamp: baseTime + 100});
    const recent = createEvent({timestamp: baseTime + 200});
    await service.appendEvent({session: created, event: oldest});
    await service.appendEvent({session: created, event: recent});

    const session = (await service.getSession({
      ...key,
      config: {numRecentEvents: 1},
    }))!;
    expect(session.events.map((e) => e.id)).toEqual([recent.id]);
    const first = createEvent({timestamp: baseTime + 1000});
    await service.appendEvent({session, event: first});
    await setStoredUpdateTime(roundToSecond(first.timestamp));

    const second = createEvent({timestamp: baseTime + 1500});
    await expect(service.appendEvent({session, event: second})).resolves.toBe(
      second,
    );
  });

  it('rejects a numRecentEvents session when a concurrent event was inserted with an earlier timestamp', async () => {
    const created = await service.createSession(key);
    const middleEvent = createEvent({
      id: 'middle-event',
      timestamp: baseTime + 200,
    });
    const recentEvent = createEvent({
      id: 'recent-event',
      timestamp: baseTime + 300,
    });
    await service.appendEvent({session: created, event: middleEvent});
    await service.appendEvent({session: created, event: recentEvent});

    const session = (await service.getSession({
      ...key,
      config: {numRecentEvents: 1},
    }))!;
    expect(session.events.map((e) => e.id)).toEqual([recentEvent.id]);

    const first = createEvent({
      id: 'first-event',
      timestamp: baseTime + 1000,
    });
    await service.appendEvent({session, event: first});
    await setStoredUpdateTime(roundToSecond(first.timestamp));

    const orm = (service as unknown as {orm: MikroORM}).orm;
    const em = orm.em.fork();
    const concurrentEarly = createEvent({
      id: 'concurrent-early',
      timestamp: baseTime + 100,
    });
    const storageEvent = em.create(StorageEvent, {
      id: concurrentEarly.id,
      appName: key.appName,
      userId: key.userId,
      sessionId: key.sessionId,
      invocationId: concurrentEarly.invocationId,
      timestamp: new Date(concurrentEarly.timestamp),
      eventData: concurrentEarly,
    });
    em.persist(storageEvent);
    await em.flush();

    const second = createEvent({
      id: 'second-event',
      timestamp: baseTime + 1500,
    });
    await expect(service.appendEvent({session, event: second})).rejects.toThrow(
      StaleSessionError,
    );
  });

  it('verifies that appendEvent handles marker-less sessions with > 500 events without SQL parameter limit errors', async () => {
    await service.createSession(key);
    const orm = (service as unknown as {orm: MikroORM}).orm;
    const em = orm.em.fork();

    const count = 505;
    const events: Event[] = [];
    const storageEvents: StorageEvent[] = [];
    for (let i = 0; i < count; i++) {
      const event = createEvent({
        id: `bulk-event-${String(i).padStart(5, '0')}`,
        timestamp: baseTime + i + 1,
      });
      events.push(event);
      storageEvents.push(
        em.create(StorageEvent, {
          id: event.id,
          appName: key.appName,
          userId: key.userId,
          sessionId: key.sessionId,
          invocationId: event.invocationId,
          timestamp: new Date(event.timestamp),
          eventData: event,
        }),
      );
    }

    for (let i = 0; i < storageEvents.length; i += 200) {
      em.persist(storageEvents.slice(i, i + 200));
      await em.flush();
    }

    const lastEvent = events[events.length - 1];
    const roundedStoredUpdateTime = roundToSecond(lastEvent.timestamp);
    await setStoredUpdateTime(roundedStoredUpdateTime);

    // Marker-less session whose events match storage exactly.
    const session = createSession({
      id: key.sessionId,
      appName: key.appName,
      userId: key.userId,
      state: {},
      events: [...events],
      lastUpdateTime: roundedStoredUpdateTime - 500,
    });

    const nextEvent = createEvent({
      id: 'bulk-next-event',
      timestamp: roundedStoredUpdateTime + 100,
    });
    // Acceptance: all stored events are known to session.events, exercising
    // the > MAX_IN_QUERY_IDS in-memory scan path.
    await expect(
      service.appendEvent({session, event: nextEvent}),
    ).resolves.toBe(nextEvent);

    // Insert a concurrent event into storage with a timestamp before the
    // latest event, so the latest event in storage still matches the session's
    // last event, but storage contains an extra event not in the session.
    const concurrentEvent = createEvent({
      id: 'concurrent-unknown',
      timestamp: baseTime + 50,
    });
    const extraStorageEvent = em.create(StorageEvent, {
      id: concurrentEvent.id,
      appName: key.appName,
      userId: key.userId,
      sessionId: key.sessionId,
      invocationId: concurrentEvent.invocationId,
      timestamp: new Date(concurrentEvent.timestamp),
      eventData: concurrentEvent,
    });
    em.persist(extraStorageEvent);
    await em.flush();

    // Now storage has: events (505), nextEvent (1), extraStorageEvent (1).
    // The latest event in storage is nextEvent.
    // Create a marker-less session that includes nextEvent as its last event
    // and >500 events, but omits concurrentEvent.
    const staleSession = createSession({
      id: key.sessionId,
      appName: key.appName,
      userId: key.userId,
      state: {},
      events: [...events, nextEvent],
      lastUpdateTime: nextEvent.timestamp - 500,
    });

    // Rejection: storage holds concurrentEvent which is not in staleSession.events.
    // The in-memory scan path detects the missing event and throws StaleSessionError.
    await expect(
      service.appendEvent({
        session: staleSession,
        event: createEvent({
          id: 'rejected-event',
          timestamp: nextEvent.timestamp + 100,
        }),
      }),
    ).rejects.toThrow(StaleSessionError);
  });

  it('compares timestamps when the caller changed lastUpdateTime', async () => {
    const session = await service.createSession(key);
    session.lastUpdateTime = baseTime - 5000;

    await expect(
      service.appendEvent({
        session,
        event: createEvent({timestamp: baseTime + 100}),
      }),
    ).rejects.toThrow(StaleSessionError);

    session.lastUpdateTime = baseTime + 5000;
    const event = createEvent({timestamp: baseTime + 6000});
    await expect(service.appendEvent({session, event})).resolves.toBe(event);

    const marker = (
      session as unknown as {
        [key: symbol]: {totalEventCount?: number; eventsComplete: boolean};
      }
    )[Symbol.for('google.adk.session.storageUpdateMarker')];
    expect(marker?.totalEventCount).toBeUndefined();
    expect(marker?.eventsComplete).toBe(false);
  });

  it('formats sub-second timestamps in StaleSessionError messages', async () => {
    const session = await service.createSession(key);
    const otherHandle = (await service.getSession(key))!;
    await service.appendEvent({
      session: otherHandle,
      event: createEvent({timestamp: baseTime + 200}),
    });

    await expect(
      service.appendEvent({
        session,
        event: createEvent({timestamp: baseTime + 300}),
      }),
    ).rejects.toThrow(
      'The last_update_time provided in the session object 2026-01-01 00:00:00.750 is earlier than the update_time in the storage_session 2026-01-01 00:00:00.950.',
    );
  });

  it('keeps the revision marker out of the enumerable session shape', async () => {
    const session = await service.createSession(key);
    await service.appendEvent({
      session,
      event: createEvent({timestamp: baseTime + 100}),
    });
    const listed = (await service.listSessions(key)).sessions[0];
    const fetched = (await service.getSession(key))!;

    for (const s of [session, listed, fetched]) {
      expect(Object.keys(s).sort()).toEqual([
        'appName',
        'events',
        'id',
        'lastUpdateTime',
        'state',
        'userId',
      ]);
      expect(Object.keys(JSON.parse(JSON.stringify(s))).sort()).toEqual(
        Object.keys(s).sort(),
      );
      expect(Object.getOwnPropertySymbols(s)).toContain(
        Symbol.for('google.adk.session.storageUpdateMarker'),
      );
    }
  });
});

describe('DatabaseSessionService with sqlite:///:memory:', () => {
  const services: DatabaseSessionService[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) {
      await (service as unknown as {orm?: MikroORM}).orm?.close();
    }
  });

  it('opens an in-memory database that is not shared', async () => {
    const first = new DatabaseSessionService('sqlite:///:memory:');
    services.push(first);
    await first.init();
    await first.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'memory-session',
      state: {key: 'value'},
    });

    const readBack = await first.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'memory-session',
    });
    expect(readBack?.state['key']).toBe('value');

    const second = new DatabaseSessionService('sqlite:///:memory:');
    services.push(second);
    await second.init();
    const unseen = await second.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'memory-session',
    });
    expect(unseen).toBeUndefined();
  });

  it('forwards additional MikroORM options when constructed with a URI string', async () => {
    const initSpy = vi.spyOn(MikroORM, 'init');
    const customService = new DatabaseSessionService('sqlite:///:memory:', {
      debug: false,
      allowGlobalContext: true,
      staleSession: 'reload',
    });
    services.push(customService);

    await customService.init();

    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dbName: ':memory:',
        debug: false,
        allowGlobalContext: true,
      }),
    );
    expect(initSpy.mock.calls[0]?.[0]).not.toHaveProperty('staleSession');
    initSpy.mockRestore();
  });

  it('honors second-argument options when the first argument is an options object', async () => {
    const initSpy = vi.spyOn(MikroORM, 'init');
    const customService = new DatabaseSessionService(
      {dbName: ':memory:', driver: SqliteDriver},
      {allowGlobalContext: true, staleSession: 'reload'},
    );
    services.push(customService);

    await customService.init();

    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dbName: ':memory:',
        driver: SqliteDriver,
        allowGlobalContext: true,
      }),
    );
    expect(initSpy.mock.calls[0]?.[0]).not.toHaveProperty('staleSession');
    initSpy.mockRestore();

    const key = {appName: 'test-app', userId: 'test-user', sessionId: 's1'};
    const session = await customService.createSession(key);
    const otherHandle = (await customService.getSession(key))!;
    const now = Date.now();
    const concurrentEvent = createEvent({timestamp: now + 10});
    await customService.appendEvent({
      session: otherHandle,
      event: concurrentEvent,
    });

    const ownEvent = createEvent({timestamp: now + 20});
    await expect(
      customService.appendEvent({session, event: ownEvent}),
    ).resolves.toBe(ownEvent);
    expect(session.events.map((e) => e.id)).toEqual([
      concurrentEvent.id,
      ownEvent.id,
    ]);
  });
});

describe('isDatabaseConnectionString', () => {
  it('should identify valid URI connection strings', () => {
    expect(
      isDatabaseConnectionString('postgres://user:pass@localhost:5432/db'),
    ).toBe(true);
    expect(
      isDatabaseConnectionString('postgresql://user:pass@localhost:5432/db'),
    ).toBe(true);
    expect(
      isDatabaseConnectionString('mysql://user:pass@localhost:3306/db'),
    ).toBe(true);
    expect(
      isDatabaseConnectionString('mariadb://user:pass@localhost:3306/db'),
    ).toBe(true);
    expect(isDatabaseConnectionString('sqlite://:memory:')).toBe(true);
    expect(isDatabaseConnectionString('sqlite:///path/to/db.sqlite')).toBe(
      true,
    );
    expect(
      isDatabaseConnectionString('mssql://user:pass@localhost:1433/db'),
    ).toBe(true);
  });

  it('should reject invalid strings', () => {
    expect(isDatabaseConnectionString('')).toBe(false);
    expect(isDatabaseConnectionString(undefined)).toBe(false);
    expect(isDatabaseConnectionString('http://google.com')).toBe(false);
    expect(isDatabaseConnectionString('https://google.com')).toBe(false);
    expect(isDatabaseConnectionString('/path/to/file')).toBe(false);
    expect(isDatabaseConnectionString('C:\\path\\to\\file')).toBe(false);
    expect(isDatabaseConnectionString('just some text')).toBe(false);
    expect(isDatabaseConnectionString('random=text;with=semicolons')).toBe(
      false,
    ); // Has = and ; but no common keys
    expect(isDatabaseConnectionString('Server=myServer')).toBe(false); // Missing semicolon implies not a full connection string or just a weird config
  });
});

describe('StaleSessionError exports', () => {
  it('exports StaleSessionError and isStaleSessionError from the common and web entry points', async () => {
    const common = await import('../../src/common.js');
    const web = await import('../../src/index_web.js');

    for (const entry of [common, web]) {
      expect(entry.StaleSessionError).toBe(StaleSessionError);
      expect(entry.isStaleSessionError).toBe(isStaleSessionError);
      expect(
        entry.isStaleSessionError(new entry.StaleSessionError('stale')),
      ).toBe(true);
    }
  });
});
