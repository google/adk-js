/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  DatabaseSessionService,
  Event,
  State,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {isDatabaseConnectionString} from '../../src/sessions/database_session_service.js';
import {validateDatabaseSchemaVersion} from '../../src/sessions/db/operations.js';

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

  it('should get a session', async () => {
    await service.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session-id',
      state: {'key': 'value'},
    });

    const session = await service.getSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session-id',
    });

    expect(session).toBeDefined();
    expect(session?.id).toBe('test-session-id');
    expect(session?.state['key']).toBe('value');
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
    await em.nativeDelete('StorageMetadata', {key: 'schema_version'});
    await em.insert('StorageMetadata', {
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
      const storedEvents = (await em.find('StorageEvent', {
        sessionId: 's-temp',
      })) as {sessionId: string; eventData: Event}[];
      const eventData = storedEvents[0].eventData;

      expect(eventData.actions?.stateDelta?.['keep']).toBe('me');
      expect(
        eventData.actions?.stateDelta?.[State.TEMP_PREFIX + 'hide'],
      ).toBeUndefined();
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
      const storedSession = (await em.findOne('StorageSession', {
        id: 's-time',
      })) as {id: string; updateTime: Date};

      expect(storedSession.updateTime.getTime()).toBe(timestamp);
    });
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
