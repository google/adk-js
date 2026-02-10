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
import {beforeEach, describe, expect, it} from 'vitest';
import {isInMemoryConnectionString} from '../../src/sessions/in_memory_session_service.js';

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
      const createdSession = await service.createSession({
        appName: 'app',
        userId: 'user',
      });
      const session = await service.getSession({
        appName: 'app',
        userId: 'user',
        sessionId: createdSession.id,
      });

      expect(session).toBeDefined();
      expect(session?.id).toBe(createdSession.id);
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
  });

  describe('listSessions', () => {
    it('returns empty list if no sessions exist', async () => {
      const response = await service.listSessions({
        appName: 'app',
        userId: 'user',
      });
      expect(response.sessions).toEqual([]);
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
  });
});
