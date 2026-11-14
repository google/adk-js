/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemorySessionService,
  Session,
  State,
  createEvent,
  createEventActions,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {isInMemoryConnectionString} from '../../src/sessions/in_memory_session_service.js';
import {logger} from '../../src/utils/logger.js';

describe('isInMemoryConnectionString', () => {
  it('returns true for memory://', () => {
    expect(isInMemoryConnectionString('memory://')).toBe(true);
  });

  it('returns false for other strings', () => {
    expect(isInMemoryConnectionString('postgres://localhost:5432')).toBe(false);
    expect(isInMemoryConnectionString('memory:/')).toBe(false);
    expect(isInMemoryConnectionString('')).toBe(false);
    expect(isInMemoryConnectionString(undefined)).toBe(false);
  });
});

describe('InMemorySessionService', () => {
  let service: InMemorySessionService;

  beforeEach(() => {
    service = new InMemorySessionService();
  });

  describe('createSession', () => {
    it('creates a new session with correct properties', async () => {
      const appName = 'test-app';
      const userId = 'test-user';
      const state = {key: 'value'};

      const session = await service.createSession({appName, userId, state});

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.appName).toBe(appName);
      expect(session.userId).toBe(userId);
      expect(session.state).toEqual(state);
      expect(session.events).toEqual([]);
      expect(session.lastUpdateTime).toBeDefined();
    });

    it('creates a session with a provided sessionId', async () => {
      const sessionId = 'custom-session-id';
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
        sessionId,
      });

      expect(session.id).toBe(sessionId);
    });

    it('merges existing app and user state into new session', async () => {
      // First, create a session and add some state
      const appName = 'shared-app';
      const userId = 'shared-user';
      const session1 = await service.createSession({appName, userId});
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            [`${State.APP_PREFIX}appKey`]: 'appValue',
            [`${State.USER_PREFIX}userKey`]: 'userValue',
          },
        }),
      });
      await service.appendEvent({session: session1, event});

      // Now create a new session for the same user and app
      const session2 = await service.createSession({appName, userId});

      expect(session2.state).toEqual({
        [`${State.APP_PREFIX}appKey`]: 'appValue',
        [`${State.USER_PREFIX}userKey`]: 'userValue',
      });
    });

    it('filters out temporary state keys prefixed with temp:', async () => {
      const appName = 'test-app';
      const userId = 'test-user';
      const state = {
        normalKey: 'value',
        [`${State.TEMP_PREFIX}tempKey`]: 'tempValue',
      };

      const session = await service.createSession({appName, userId, state});

      expect(session.state).toHaveProperty('normalKey', 'value');
      expect(session.state).not.toHaveProperty(`${State.TEMP_PREFIX}tempKey`);
    });
  });

  describe('getSession', () => {
    it('returns undefined if session does not exist', async () => {
      const session = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: 'non-existent',
      });
      expect(session).toBeUndefined();
    });

    it('returns the session if it exists', async () => {
      const beforeCreate = Date.now();
      const createdSession = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      expect(createdSession.lastUpdateTime).toBeGreaterThanOrEqual(
        beforeCreate,
      );
      expect(createdSession.lastUpdateTime).toBeLessThanOrEqual(Date.now());
      const session = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: createdSession.id,
      });

      expect(session).toBeDefined();
      expect(session?.id).toBe(createdSession.id);
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

    it('respects numRecentEvents config', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      for (let i = 0; i < 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({timestamp: i}),
        });
      }

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
        config: {numRecentEvents: 2},
      });

      expect(retrievedSession?.events).toHaveLength(2);
      expect(retrievedSession?.events[0].timestamp).toBe(3);
      expect(retrievedSession?.events[1].timestamp).toBe(4);
    });

    it('respects afterTimestamp config', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      for (let i = 0; i < 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({timestamp: i * 1000}),
        });
      }

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
        config: {afterTimestamp: 2500},
      });

      expect(retrievedSession?.events).toHaveLength(2);
      expect(retrievedSession?.events[0].timestamp).toBe(3000);
      expect(retrievedSession?.events[1].timestamp).toBe(4000);
    });

    it('merges current state into retrieved session', async () => {
      const appName = 'app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});

      // Update state in another session (simulated by directly modifying internal state or another session)
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            [`${State.APP_PREFIX}key`]: 'newValue',
          },
        }),
      });
      await service.appendEvent({session, event});

      const retrievedSession = await service.getSession({
        appName,
        userId,
        sessionId: session.id,
      });

      expect(retrievedSession?.state).toEqual({
        [`${State.APP_PREFIX}key`]: 'newValue',
      });
    });

    it('includes events matching afterTimestamp boundary inclusively', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      for (let i = 1; i <= 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({author: 'user', timestamp: i}),
        });
      }

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
        config: {afterTimestamp: 4},
      });

      expect(retrievedSession?.events).toHaveLength(2);
      expect(retrievedSession?.events[0].timestamp).toBe(4);
      expect(retrievedSession?.events[1].timestamp).toBe(5);
    });

    it('returns no events when afterTimestamp is newer than all events', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      for (let i = 1; i <= 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({author: 'user', timestamp: i}),
        });
      }

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
        config: {afterTimestamp: 50},
      });

      expect(retrievedSession?.events).toEqual([]);
    });

    it('applies both numRecentEvents and afterTimestamp filters when configured', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      for (let i = 1; i <= 5; i++) {
        await service.appendEvent({
          session,
          event: createEvent({author: 'user', timestamp: i}),
        });
      }

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
        config: {afterTimestamp: 4, numRecentEvents: 3},
      });

      expect(retrievedSession?.events).toHaveLength(2);
      expect(retrievedSession?.events[0].timestamp).toBe(4);
      expect(retrievedSession?.events[1].timestamp).toBe(5);
    });
  });

  describe('listSessions', () => {
    it('returns empty list if no sessions exist', async () => {
      const response = await service.listSessions({
        appName: 'app',
        userId: 'user',
      });
      expect(response.sessions).toEqual([]);
      expect(response.page).toBe(1);
      expect(response.limit).toBe(0);
      expect(response.totalItems).toBe(0);
      expect(response.totalPages).toBe(0);
    });

    it('returns list of sessions without events', async () => {
      const appName = 'app';
      const userId = 'user';
      await service.createSession({appName, userId});
      await service.createSession({appName, userId});

      const response = await service.listSessions({appName, userId});

      expect(response.sessions).toHaveLength(2);
      expect(response.sessions[0].events).toEqual([]);
      expect(response.sessions[1].events).toEqual([]);
    });

    it('lists every user of the app when userId is omitted', async () => {
      const appName = 'app';
      await service.createSession({appName, userId: 'user1'});
      await service.createSession({appName, userId: 'user2'});
      await service.createSession({appName: 'other-app', userId: 'user1'});

      const response = await service.listSessions({appName});

      expect(response.sessions).toHaveLength(2);
      expect(response.sessions.map((s) => s.userId).sort()).toEqual([
        'user1',
        'user2',
      ]);
      expect(response.totalItems).toBe(2);
    });

    it('limit on empty result → returns pagination metadata with zeros', async () => {
      const response = await service.listSessions({
        appName: 'app',
        userId: 'user',
        limit: 10,
      });
      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(0);
      expect(response.totalPages).toBe(0);
      expect(response.page).toBe(1);
      expect(response.limit).toBe(10);
    });

    it('no pagination params → returns all sessions with page=1', async () => {
      const appName = 'app';
      const userId = 'user';
      await service.createSession({appName, userId});
      await service.createSession({appName, userId});

      const response = await service.listSessions({appName, userId});

      expect(response.page).toBe(1);
      expect(response.limit).toBe(2);
      expect(response.totalItems).toBe(2);
      expect(response.totalPages).toBe(1);
    });

    it('order asc returns oldest-first', async () => {
      const appName = 'app';
      const userId = 'user';
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
        event: createEvent({timestamp: 3000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 1000}),
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

      expect(response.sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
    });

    it('order desc returns newest-first', async () => {
      const appName = 'app';
      const userId = 'user';
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
        event: createEvent({timestamp: 3000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 1000}),
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

      expect(response.sessions.map((s) => s.id)).toEqual(['s1', 's3', 's2']);
    });

    it('tie-breaking by id when lastUpdateTime values are equal', async () => {
      const appName = 'app';
      const userId = 'user';
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
        event: createEvent({timestamp: 1000}),
      });
      await service.appendEvent({
        session: s2,
        event: createEvent({timestamp: 1000}),
      });

      const asc = await service.listSessions({appName, userId, order: 'asc'});
      expect(asc.sessions.map((s) => s.id)).toEqual(['s1', 's2']);

      const desc = await service.listSessions({appName, userId, order: 'desc'});
      expect(desc.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    });

    it('limit returns only N sessions', async () => {
      const appName = 'app';
      const userId = 'user';
      for (let i = 1; i <= 5; i++) {
        await service.createSession({appName, userId, sessionId: `s${i}`});
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
    });

    it('offset skips N sessions', async () => {
      const appName = 'app';
      const userId = 'user';
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
        event: createEvent({timestamp: 2000}),
      });
      await service.appendEvent({
        session: s3,
        event: createEvent({timestamp: 3000}),
      });

      const response = await service.listSessions({
        appName,
        userId,
        limit: 2,
        offset: 1,
        order: 'asc',
      });

      expect(response.sessions.map((s) => s.id)).toEqual(['s2', 's3']);
    });

    it('page + limit returns correct slice', async () => {
      const appName = 'app';
      const userId = 'user';
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

    it('offset beyond total → empty sessions with correct metadata', async () => {
      const appName = 'app';
      const userId = 'user';
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
      const appName = 'app';
      const userId = 'user';
      await service.createSession({appName, userId, sessionId: 's1'});

      const response = await service.listSessions({appName, userId, limit: 0});

      expect(response.sessions).toEqual([]);
      expect(response.totalItems).toBe(1);
      expect(response.totalPages).toBe(0);
    });

    it('order without limit returns all sessions sorted with page=1', async () => {
      const appName = 'app';
      const userId = 'user';
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
      const appName = 'app';
      const userId = 'user';
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

      // page=2, limit=2 → sessions 3,4; offset=0 should be ignored
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

  describe('deleteSession', () => {
    it('deletes an existing session', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      await service.deleteSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });
      expect(retrievedSession).toBeUndefined();
    });

    it('does nothing if session does not exist', async () => {
      await expect(
        service.deleteSession({
          appName: 'app',
          userId: 'user',
          sessionId: 'non-existent',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('appendEvent', () => {
    it('appends event to session and updates lastUpdateTime', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      const timestamp = Date.now() + 1000;
      const event = createEvent({timestamp});

      await service.appendEvent({session, event});

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });
      expect(retrievedSession?.events).toHaveLength(1);
      expect(retrievedSession?.events[0]).toEqual(event);
      expect(retrievedSession?.lastUpdateTime).toBe(timestamp);
    });

    it('updates app state', async () => {
      const appName = 'app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            [`${State.APP_PREFIX}key`]: 'value',
          },
        }),
      });

      await service.appendEvent({session, event});

      // Check via side channel (create another session to see if state persists)
      const session2 = await service.createSession({appName, userId});
      expect(session2.state).toHaveProperty(`${State.APP_PREFIX}key`, 'value');
    });

    it('updates user state', async () => {
      const appName = 'app';
      const userId = 'user';
      const session = await service.createSession({appName, userId});
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {
            [`${State.USER_PREFIX}key`]: 'value',
          },
        }),
      });

      await service.appendEvent({session, event});

      const session2 = await service.createSession({appName, userId});
      expect(session2.state).toHaveProperty(`${State.USER_PREFIX}key`, 'value');
    });

    it('keeps temp: state in the session for the invocation but does not store it', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {[`${State.TEMP_PREFIX}draft`]: 'text', kept: 'value'},
        }),
      });

      await service.appendEvent({session, event});

      expect(session.state[`${State.TEMP_PREFIX}draft`]).toBe('text');
      expect(event.actions.stateDelta).toEqual({kept: 'value'});
      const stored = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });
      expect(stored?.state).toEqual({kept: 'value'});
    });

    it('handles non-existent app/user/session gracefully', async () => {
      const session: Session = {
        id: 'fake-session',
        appName: 'fake-app',
        userId: 'fake-user',
        state: {},
        events: [],
        lastUpdateTime: 0,
      };
      const event = createEvent({timestamp: Date.now()});

      // Should just log warnings and return event
      const returnedEvent = await service.appendEvent({session, event});
      expect(returnedEvent).toBe(event);
    });

    it('logs a warning when appName is not in sessions', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const session: Session = {
        id: 'missing-session',
        appName: 'unknown-app',
        userId: 'user-1',
        state: {},
        events: [],
        lastUpdateTime: 0,
      };
      const event = createEvent({timestamp: Date.now()});

      const returnedEvent = await service.appendEvent({session, event});

      expect(returnedEvent).toBe(event);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to append event to session missing-session: appName unknown-app not in sessions',
      );
      warnSpy.mockRestore();
    });

    it('logs a warning when userId is not in sessions for the appName', async () => {
      await service.createSession({
        appName: 'known-app',
        userId: 'existing-user',
        sessionId: 'existing-session',
      });
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const session: Session = {
        id: 'missing-session',
        appName: 'known-app',
        userId: 'unknown-user',
        state: {},
        events: [],
        lastUpdateTime: 0,
      };
      const event = createEvent({timestamp: Date.now()});

      const returnedEvent = await service.appendEvent({session, event});

      expect(returnedEvent).toBe(event);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to append event to session missing-session: userId unknown-user not in sessions[appName]',
      );
      warnSpy.mockRestore();
    });

    it('logs a warning when sessionId is not in sessions for the appName and userId', async () => {
      await service.createSession({
        appName: 'known-app',
        userId: 'known-user',
        sessionId: 'existing-session',
      });
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const session: Session = {
        id: 'unknown-session',
        appName: 'known-app',
        userId: 'known-user',
        state: {},
        events: [],
        lastUpdateTime: 0,
      };
      const event = createEvent({timestamp: Date.now()});

      const returnedEvent = await service.appendEvent({session, event});

      expect(returnedEvent).toBe(event);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to append event to session unknown-session: sessionId unknown-session not in sessions[appName][userId]',
      );
      warnSpy.mockRestore();
    });
  });

  describe('appendEvent event payload persistence', () => {
    it('preserves inlineData parts when appending and retrieving events', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
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

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });
      expect(retrievedSession?.events).toHaveLength(1);
      expect(retrievedSession?.events[0].content?.parts?.[0]).toEqual(
        inlinePart,
      );
    });

    it('persists and restores a complete event with all metadata and actions fields', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
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

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });
      expect(retrievedSession).toEqual(session);
    });

    it('ignores partial events with content', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
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

      const retrievedSession = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: session.id,
      });
      expect(retrievedSession?.events).toEqual([]);
    });
  });

  describe('prototype pollution', () => {
    // Every key that any test below can plant on `Object.prototype` when the
    // fix is reverted, so that reverting it fails these tests instead of
    // corrupting the ones that run afterwards. `sessions['app1']['__proto__']`
    // resolves to `Object.prototype`, so the *session id* lands there too, and
    // `sessions['__proto__']` does the same for the *user id*.
    const POLLUTED_KEYS = [
      'polluted',
      'httpOptions',
      'pwned',
      'baseUrl',
      'poc_sid',
      'isAdmin',
      'u1',
      's1',
    ];

    const clearPollution = () => {
      for (const key of POLLUTED_KEYS) {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    };

    beforeEach(clearPollution);
    afterEach(clearPollution);

    // A `'__proto__': value` pair in an object literal invokes the prototype
    // setter instead of creating an own key, so it cannot express what an
    // attacker actually sends. `JSON.parse` is what the dev server does with a
    // request body, and it does produce an own `__proto__` key.
    const parseBody = (json: string): Record<string, unknown> =>
      JSON.parse(json) as Record<string, unknown>;

    it('does not pollute Object.prototype via appName', async () => {
      await service.createSession({
        appName: '__proto__',
        userId: 'polluted',
        sessionId: 'poc_sid',
        state: {},
      });

      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('does not pollute Object.prototype via userId in user state', async () => {
      const session = await service.createSession({
        appName: 'app1',
        userId: '__proto__',
        sessionId: 's1',
        state: {},
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: {
              [`${State.USER_PREFIX}httpOptions`]: {
                baseUrl: 'https://evil.test',
              },
            },
          }),
        }),
      });

      expect(({} as Record<string, unknown>)['httpOptions']).toBeUndefined();
    });

    it('does not pollute Object.prototype via appName in app state', async () => {
      const session = await service.createSession({
        appName: '__proto__',
        userId: 'u1',
        sessionId: 's1',
        state: {},
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: {[`${State.APP_PREFIX}pwned`]: 'attacker-value'},
          }),
        }),
      });

      expect(({} as Record<string, unknown>)['pwned']).toBeUndefined();
    });

    it('keeps a __proto__ user state key as an own property', async () => {
      const session = await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
        state: {},
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: {
              [`${State.USER_PREFIX}__proto__`]: {
                baseUrl: 'https://evil.test',
              },
            },
          }),
        }),
      });

      // Read the key back through a *second* session. `updateSessionState`
      // also writes the prefixed key into the originating session's own state,
      // so only a sibling session exercises the `userState` map: writing
      // `__proto__` into a plain map re-parents it rather than storing an own
      // key, and `mergeStates` then silently drops the entry for every other
      // session of the same user.
      const sibling = await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's2',
      });
      expect(sibling.state[`${State.USER_PREFIX}__proto__`]).toEqual({
        baseUrl: 'https://evil.test',
      });
    });

    it('does not re-parent session state via __proto__ in the initial state', async () => {
      const session = await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
        state: parseBody('{"__proto__": {"isAdmin": true}}'),
      });

      // The `__proto__` entry stays an own key instead of re-parenting state.
      expect(new State(session.state).get('isAdmin')).toBeUndefined();
      expect(session.state['__proto__']).toEqual({isAdmin: true});
    });

    it('does not re-parent session state via __proto__ in a state delta', async () => {
      const session = await service.createSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
      });
      await service.appendEvent({
        session,
        event: createEvent({
          timestamp: Date.now(),
          actions: createEventActions({
            stateDelta: parseBody('{"__proto__": {"isAdmin": true}}'),
          }),
        }),
      });

      const stored = await service.getSession({
        appName: 'app1',
        userId: 'u1',
        sessionId: 's1',
      });
      expect(new State(stored!.state).get('isAdmin')).toBeUndefined();
      expect(stored?.state['__proto__']).toEqual({isAdmin: true});
    });

    it('does not leak sessions across apps as phantom entries', async () => {
      await service.createSession({
        appName: '__proto__',
        userId: 'polluted',
        sessionId: 'poc_sid',
        state: {},
      });

      // An app/user pair that was never created must stay empty.
      const phantom = await service.listSessions({
        appName: 'polluted',
        userId: 'polluted',
      });
      expect(phantom.sessions).toHaveLength(0);

      // A real, unrelated app must not gain a phantom user either.
      await service.createSession({
        appName: 'real_app',
        userId: 'alice',
        sessionId: 's1',
      });
      const phantomUser = await service.listSessions({
        appName: 'real_app',
        userId: 'polluted',
      });
      expect(phantomUser.sessions).toHaveLength(0);
    });

    it('still stores and retrieves an app literally named __proto__', async () => {
      await service.createSession({
        appName: '__proto__',
        userId: 'polluted',
        sessionId: 'poc_sid',
        state: {},
      });

      const session = await service.getSession({
        appName: '__proto__',
        userId: 'polluted',
        sessionId: 'poc_sid',
      });
      expect(session?.id).toBe('poc_sid');
    });
  });
});

describe('InMemorySessionService createSession session id', () => {
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let service: InMemorySessionService;

  beforeEach(() => {
    service = new InMemorySessionService();
  });

  it('stores and returns a padded id without its whitespace', async () => {
    const session = await service.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: ' abc ',
    });

    expect(session.id).toBe('abc');
    const found = await service.getSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'abc',
    });
    expect(found?.id).toBe('abc');
  });

  it('generates an id when the given id is only whitespace', async () => {
    const session = await service.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: '   ',
    });

    expect(session.id).toHaveLength(36);
    expect(session.id).toMatch(UUID_PATTERN);
    const found = await service.getSession({
      appName: 'app',
      userId: 'user',
      sessionId: session.id,
    });
    expect(found?.id).toBe(session.id);
  });
});

const initial = {
  'app:theme': 'dark',
  'user:language': 'en',
  local: 'first',
};

async function seededService() {
  const service = new InMemorySessionService();
  const first = await service.createSession({
    appName: 'app',
    userId: 'user',
    sessionId: 'first',
    state: initial,
  });
  return {service, first};
}

describe('InMemorySessionService initial scoped state', () => {
  it('shares initial app and user state with the next session of the user', async () => {
    const {service} = await seededService();
    const next = await service.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'second',
    });
    expect(next.state).toEqual({'app:theme': 'dark', 'user:language': 'en'});
  });

  it('shares only initial app state with another user', async () => {
    const {service} = await seededService();
    const next = await service.createSession({
      appName: 'app',
      userId: 'another-user',
      sessionId: 'second',
    });
    expect(next.state).toEqual({'app:theme': 'dark'});
  });

  it('does not share initial state across applications', async () => {
    const {service} = await seededService();
    const next = await service.createSession({
      appName: 'another-app',
      userId: 'user',
      sessionId: 'second',
    });
    expect(next.state).toEqual({});
  });

  it('stores only session-scoped initial keys in the session record', async () => {
    const {service, first} = await seededService();
    const stored = (
      service as unknown as {
        sessions: Record<string, Record<string, Record<string, Session>>>;
      }
    ).sessions[first.appName][first.userId][first.id];
    expect(stored.state).toEqual({local: 'first'});
  });

  it('returns all initial state to its owning session', async () => {
    const {first} = await seededService();
    expect(first.state).toEqual(initial);
    expect(first.events).toEqual([]);
  });

  it('continues sharing state written through appendEvent', async () => {
    const service = new InMemorySessionService();
    const first = await service.createSession({appName: 'app', userId: 'user'});
    await service.appendEvent({
      session: first,
      event: createEvent({actions: createEventActions({stateDelta: initial})}),
    });
    const next = await service.createSession({appName: 'app', userId: 'user'});
    expect(next.state).toEqual({'app:theme': 'dark', 'user:language': 'en'});
  });

  it('makes newly initialized keys visible when an earlier empty session is read', async () => {
    const service = new InMemorySessionService();
    const key = {appName: 'app', userId: 'user', sessionId: 'earlier'};
    await service.createSession(key);
    await service.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'initialized',
      state: initial,
    });
    expect((await service.getSession(key))?.state).toEqual({
      'app:theme': 'dark',
      'user:language': 'en',
    });
  });

  it('overwrites existing shared values with new initial values', async () => {
    const service = new InMemorySessionService();
    const first = await service.createSession({appName: 'app', userId: 'user'});
    const existing = Object.fromEntries(
      ['app:', 'user:'].flatMap((prefix) =>
        [undefined, null, false, 0, '', 'existing'].map((value, index) => [
          `${prefix}key${index}`,
          value,
        ]),
      ),
    );
    await service.appendEvent({
      session: first,
      event: createEvent({actions: createEventActions({stateDelta: existing})}),
    });
    const key = {appName: 'app', userId: 'user', sessionId: 'conflicting'};
    const conflicting = await service.createSession({
      ...key,
      state: Object.fromEntries(
        Object.keys(existing).map((name) => [name, 'replacement']),
      ),
    });
    const reread = await service.getSession(key);
    const earlier = await service.getSession({
      appName: first.appName,
      userId: first.userId,
      sessionId: first.id,
    });
    const next = await service.createSession({appName: 'app', userId: 'user'});
    for (const state of [
      conflicting.state,
      reread!.state,
      earlier!.state,
      next.state,
    ]) {
      for (const name of Object.keys(existing)) {
        expect(Object.hasOwn(state, name)).toBe(true);
        expect(state[name]).toBe('replacement');
      }
    }
  });

  it('keeps event updates authoritative after initialization', async () => {
    const {service, first} = await seededService();
    await service.appendEvent({
      session: first,
      event: createEvent({
        actions: createEventActions({
          stateDelta: {'app:theme': 'light', 'user:language': 'fr'},
        }),
      }),
    });
    const loaded = await service.getSession({
      appName: first.appName,
      userId: first.userId,
      sessionId: first.id,
    });
    expect(loaded?.state).toEqual({
      'app:theme': 'light',
      'user:language': 'fr',
      local: 'first',
    });
    const next = await service.createSession({appName: 'app', userId: 'user'});
    expect(next.state).toEqual({'app:theme': 'light', 'user:language': 'fr'});
  });

  it('filters temporary state while keeping local state in the owning session', async () => {
    const service = new InMemorySessionService();
    const first = await service.createSession({
      appName: 'app',
      userId: 'user',
      state: {'temp:note': 'temporary', local: 'private'},
    });
    expect(first.state).toEqual({local: 'private'});
    const next = await service.createSession({appName: 'app', userId: 'user'});
    expect(next.state).toEqual({});
  });
});
