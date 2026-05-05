/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {createEvent, VertexAiSessionService} from '@google/adk';
import {Session} from '@google/adk/sessions/session.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

// Mock the unreleased nodejs-vertexai package so the import resolves
vi.mock('nodejs-vertexai', () => ({
  SessionsClient: class {
    create = vi.fn();
    get = vi.fn();
    list = vi.fn();
    delete = vi.fn();
    events = {append: vi.fn()};
  },
}));

import {isVertexAiConnectionString} from '@google/adk/sessions/vertex_ai_session_service.js';
import {logger} from '@google/adk/utils/logger.js';

describe('isVertexAiConnectionString', () => {
  it('returns true for vertexai://', () => {
    expect(isVertexAiConnectionString('vertexai://projects/abc')).toBe(true);
  });

  it('returns false for other strings', () => {
    expect(isVertexAiConnectionString('postgres://localhost:5432')).toBe(false);
    expect(isVertexAiConnectionString('memory:/')).toBe(false);
    expect(isVertexAiConnectionString('')).toBe(false);
    expect(isVertexAiConnectionString(undefined)).toBe(false);
  });
});

describe('VertexAiSessionService', () => {
  let service: VertexAiSessionService;
  interface MockSessions {
    createInternal: ReturnType<typeof vi.fn>;
    getSessionOperationInternal: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    listInternal: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    events: {
      listInternal: ReturnType<typeof vi.fn>;
      append: ReturnType<typeof vi.fn>;
    };
  }
  let mockClient: MockSessions;

  beforeEach(() => {
    mockClient = {
      createInternal: vi.fn().mockResolvedValue({
        name: 'operations/test-operation-id',
      }),
      getSessionOperationInternal: vi.fn().mockResolvedValue({
        done: true,
        response: {
          name: 'projects/p/locations/l/sessions/test-id',
          sessionState: {},
          update_time: {
            timestamp: new Date().toISOString(),
          },
        },
      }),
      get: vi.fn().mockResolvedValue({
        userId: 'testUser',
        sessionState: {},
        updateTime: new Date().toISOString(),
      }),
      listInternal: vi.fn().mockResolvedValue({
        sessions: [
          {
            name: 'projects/p/locations/l/sessions/test-list-1',
            userId: 'testUser',
          },
          {name: 'malformed_name', userId: 'testUser'},
        ],
      }),
      delete: vi.fn().mockResolvedValue({}),
      events: {
        listInternal: vi.fn().mockResolvedValue({sessionEvents: []}),
        append: vi.fn().mockResolvedValue({}),
      },
    };

    service = new VertexAiSessionService({
      sessions: mockClient as unknown as Sessions,
    });
  });

  it('can initialize without passing a client explicitly', () => {
    const defaultService = new VertexAiSessionService({
      projectId: 'test-project',
      location: 'us-central1',
    });
    expect(defaultService).toBeDefined();
  });

  it('throws an error if no client and no project/location provided', () => {
    expect(() => new VertexAiSessionService({})).toThrow(
      'Either (Project ID and Location) or an expressModeApiKey is required.',
    );
  });

  it('uses agentEngineId if provided', async () => {
    const serviceWithEngineId = new VertexAiSessionService({
      sessions: mockClient as unknown as Sessions,
      agentEngineId: 'custom-engine-id',
    });

    await serviceWithEngineId.createSession({
      appName: '12345',
      userId: 'testUser',
    });

    expect(mockClient.createInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'reasoningEngines/custom-engine-id',
      }),
    );
  });

  it('throws error if appName is invalid', async () => {
    await expect(
      service.createSession({
        appName: 'invalid-app-name',
        userId: 'testUser',
      }),
    ).rejects.toThrow('App name invalid-app-name is not valid');
  });

  it('extracts reasoning engine id from full resource name', async () => {
    mockClient.createInternal.mockResolvedValue({
      name: 'projects/p/locations/l/sessions/test-id',
      done: true,
      response: {
        name: 'projects/p/locations/l/sessions/test-id',
        session_state: {},
      },
    });

    await service.createSession({
      appName: 'projects/my-project/locations/us-central1/reasoningEngines/999',
      userId: 'testUser',
    });

    expect(mockClient.createInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'reasoningEngines/999',
      }),
    );
  });

  describe('createSession', () => {
    it('creates a new session generating a random id', async () => {
      const session = await service.createSession({
        appName: '12345', // Must be digits or resource name
        userId: 'testUser',
        state: {foo: 'bar'},
      });

      expect(session.id).toBe('test-id'); // Read from mock name 'test-id'
      expect(session.appName).toBe('12345');
      expect(mockClient.createInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/12345',
        userId: 'testUser',
        config: {sessionState: {foo: 'bar'}},
      });
    });

    it('passes sessionId in config if provided', async () => {
      await service.createSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'user-provided-id',
      });

      expect(mockClient.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sessionId: 'user-provided-id',
          }),
        }),
      );
    });

    it('throws error if session creation operation times out', async () => {
      mockClient.createInternal.mockResolvedValue({
        name: 'operation-123',
        done: false,
      });
      mockClient.getSessionOperationInternal.mockResolvedValue({
        name: 'operation-123',
        done: false,
      });

      vi.useFakeTimers();

      const createPromise = service.createSession({
        appName: '12345',
        userId: 'testUser',
      });

      await Promise.all([
        expect(createPromise).rejects.toThrow(
          'Session creation operation operation-123 did not complete in time.',
        ),
        vi.runAllTimersAsync(),
      ]);

      vi.useRealTimers();
    });

    it('falls back to Date.now if update_time is missing in createSession', async () => {
      mockClient.createInternal.mockResolvedValue({
        name: 'projects/p/locations/l/operations/o',
        done: true,
        response: {
          name: 'projects/p/locations/l/sessions/test-id',
          // update_time is missing!
        },
      });

      const session = await service.createSession({
        appName: '12345',
        userId: 'testUser',
      });

      expect(session.lastUpdateTime).toBeGreaterThan(0);
    });
  });

  describe('getSession', () => {
    it('returns the session if it exists', async () => {
      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session).toBeDefined();
      expect(session?.id).toBe('my-session-id');
      expect(session?.appName).toBe('12345');
      expect(mockClient.get).toHaveBeenCalledWith({
        name: 'reasoningEngines/12345/sessions/my-session-id',
      });
      expect(mockClient.events.listInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/12345/sessions/my-session-id',
        config: {},
      });
    });

    it('calls get without listing events when numRecentEvents is 0', async () => {
      await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
        config: {numRecentEvents: 0},
      });

      expect(mockClient.get).toHaveBeenCalled();
      expect(mockClient.events.listInternal).not.toHaveBeenCalled();
    });

    it('applies afterTimestamp filter when listing events', async () => {
      const afterTimestamp = 1600000000000;
      await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
        config: {afterTimestamp},
      });

      expect(mockClient.events.listInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            filter: `timestamp>="${new Date(afterTimestamp).toISOString()}"`,
          }),
        }),
      );
    });

    it('throws error if session does not belong to user', async () => {
      mockClient.get.mockResolvedValue({
        name: 'reasoningEngines/12345/sessions/my-session-id',
        userId: 'otherUser',
      });

      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      await expect(
        service.getSession({
          appName: '12345',
          userId: 'testUser',
          sessionId: 'my-session-id',
        }),
      ).rejects.toThrow(
        'Session my-session-id does not belong to user testUser',
      );

      loggerSpy.mockRestore();
    });

    it('parses events from API response including compaction and usage metadata', async () => {
      const mockApiEvent = {
        name: 'projects/p/locations/l/sessions/s/events/e1',
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'hi'}]},
        timestamp: '2026-04-09T13:00:00Z',
        eventMetadata: {
          customMetadata: {
            _compaction: {
              startTime: 1600000000000,
              endTime: 1610000000000,
              compactedContent: {role: 'user', parts: [{text: 'summary'}]},
            },
            _usage_metadata: {promptTokens: 10},
          },
        },
      };

      mockClient.events.listInternal.mockResolvedValue({
        sessionEvents: [mockApiEvent],
      });

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session?.events).toHaveLength(1);
      const parsedEvent = session?.events[0];
      expect(parsedEvent?.isCompacted).toBe(true);
      expect(parsedEvent?.usageMetadata).toEqual({promptTokens: 10});
    });

    it('slices events based on numRecentEvents', async () => {
      mockClient.events.listInternal.mockResolvedValue({
        sessionEvents: [
          {name: 'e1', timestamp: '2026-04-09T13:00:00Z'},
          {name: 'e2', timestamp: '2026-04-09T13:01:00Z'},
        ],
      });

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
        config: {numRecentEvents: 1},
      });

      expect(session?.events).toHaveLength(1);
      expect(session?.events[0].id).toBe('e2');
    });

    it('returns undefined if session does not exist (code 5)', async () => {
      mockClient.get.mockRejectedValueOnce({code: 5, message: 'Not found'});

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session).toBeUndefined();
    });

    it('returns undefined if session does not exist (code 404)', async () => {
      mockClient.get.mockRejectedValueOnce({code: 404, message: 'Not found'});

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session).toBeUndefined();
    });

    it('falls back to empty array if sessionEvents is missing in getSession', async () => {
      mockClient.get.mockResolvedValue({
        name: 'reasoningEngines/12345/sessions/my-session-id',
        userId: 'testUser',
      });
      mockClient.events.listInternal.mockResolvedValue({}); // No sessionEvents!

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session?.events).toEqual([]);
    });

    it('falls back to defaults in getSession when state or updateTime is missing', async () => {
      mockClient.get.mockResolvedValue({
        name: 'reasoningEngines/12345/sessions/my-session-id',
        userId: 'testUser',
        // sessionState and updateTime missing!
      });

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session?.state).toEqual({});
      expect(session?.lastUpdateTime).toBeGreaterThan(0);
    });

    it('falls back to defaults in _fromApiEvent when actions or timestamp is missing', async () => {
      const mockApiEvent = {
        name: 'projects/p/locations/l/sessions/s/events/e1',
        author: 'user',
        content: {role: 'user', parts: []},
        // actions and timestamp missing!
      };

      mockClient.get.mockResolvedValue({
        name: 'reasoningEngines/12345/sessions/my-session-id',
        userId: 'testUser',
      });
      mockClient.events.listInternal.mockResolvedValue({
        sessionEvents: [mockApiEvent],
      });

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session?.events[0].actions).toEqual({
        skipSummarization: undefined,
        stateDelta: {},
        artifactDelta: {},
        transferToAgent: undefined,
        escalate: undefined,
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
        compaction: undefined,
      });
      expect(session?.events[0].timestamp).toBeGreaterThan(0);
    });

    it('throws error and logs it if error is not NOT_FOUND', async () => {
      const loggerSpy = vi
        .spyOn(logger, 'error')
        .mockImplementation(() => undefined);
      mockClient.get.mockRejectedValueOnce({
        code: 9,
        message: 'Permission Denied',
      });

      await expect(
        service.getSession({
          appName: '12345',
          userId: 'testUser',
          sessionId: 'my-session-id',
        }),
      ).rejects.toThrow('Permission Denied');
      expect(loggerSpy).toHaveBeenCalled();
    });
  });

  describe('listSessions', () => {
    it('returns list of sessions parsing name extracts', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {
            name: 'projects/p/locations/l/sessions/test-list-1',
            userId: 'testUser',
          },
          {name: 'malformed_name', userId: 'testUser'},
        ],
      });

      const response = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
      });

      expect(mockClient.listInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/12345',
        config: {filter: 'userId="testUser"'},
      });
      expect(response.sessions).toHaveLength(2);
      expect(response.sessions[0].id).toBe('test-list-1');
      expect(response.sessions[1].id).toBe('malformed_name');
    });

    it('lists sessions without filter if userId is missing', async () => {
      await service.listSessions({
        appName: '12345',
      });

      expect(mockClient.listInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {},
        }),
      );
    });

    it('falls back to defaults in listSessions when state or updateTime is missing', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [{name: 'projects/p/locations/l/sessions/s1', userId: 'u1'}],
      });

      const result = await service.listSessions({
        appName: '12345',
      });

      expect(result.sessions[0].state).toEqual({});
      expect(result.sessions[0].lastUpdateTime).toBeGreaterThan(0);
    });

    it('returns empty list if no sessions found in listSessions', async () => {
      mockClient.listInternal.mockResolvedValue({}); // No sessions!

      const result = await service.listSessions({
        appName: '12345',
      });

      expect(result.sessions).toEqual([]);
    });

    it('parses sessionState and updateTime in listSessions', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {
            name: 'projects/p/locations/l/sessions/s1',
            userId: 'u1',
            sessionState: {foo: 'bar'},
            updateTime: '2026-04-09T13:00:00Z',
          },
        ],
      });

      const result = await service.listSessions({
        appName: '12345',
      });

      expect(result.sessions[0].state).toEqual({foo: 'bar'});
      expect(result.sessions[0].lastUpdateTime).toBe(
        new Date('2026-04-09T13:00:00Z').getTime(),
      );
    });
  });

  describe('deleteSession', () => {
    it('deletes an existing session', async () => {
      await service.deleteSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'delete-session',
      });

      expect(mockClient.delete).toHaveBeenCalledWith({
        name: `reasoningEngines/12345/sessions/delete-session`,
      });
    });
  });

  describe('appendEvent', () => {
    it('appends event to session and falls back on empty invocationId/author', async () => {
      const session = {
        id: 'append-session',
        appName: '12345',
        userId: 'testUser',
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session;

      const event = createEvent({
        timestamp: 1620000000000,
        author: undefined,
        invocationId: '',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });

      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      await service.appendEvent({session, event});
      dateSpy.mockRestore();

      expect(session.events).toHaveLength(1);
      expect(session.events[0]).toEqual(event);
      expect(session.lastUpdateTime).toBe(event.timestamp);

      expect(mockClient.events.append).toHaveBeenCalledWith({
        name: 'reasoningEngines/12345/sessions/append-session',
        author: 'user',
        invocationId: 'inv-1700000000000',
        timestamp: new Date(1620000000000).toISOString(),
        config: {
          content: {role: 'model', parts: [{text: 'hello'}]},
          actions: {
            artifactDelta: {},
            requestedAuthConfigs: {},
            requestedToolConfirmations: {},
            stateDelta: {},
          },
          errorCode: undefined,
          errorMessage: undefined,
          eventMetadata: {
            partial: undefined,
            turnComplete: undefined,
            interrupted: undefined,
            branch: undefined,
            customMetadata: undefined,
            longRunningToolIds: [],
            groundingMetadata: undefined,
          },
          rawEvent: expect.any(Object),
        },
      });
    });

    it('appends compaction metadata if event is compacted', async () => {
      const session = {
        id: 's1',
        appName: '12345',
        userId: 'u1',
        events: [],
      } as unknown as Session;
      const event = createEvent({
        timestamp: Date.now(),
        content: {role: 'model', parts: []},
      });
      const eventWithCompaction = event as unknown as {
        isCompacted: boolean;
        startTime: number;
        endTime: number;
        compactedContent: object;
      };
      eventWithCompaction.isCompacted = true;
      eventWithCompaction.startTime = 1000;
      eventWithCompaction.endTime = 2000;
      eventWithCompaction.compactedContent = {role: 'user', parts: []};

      await service.appendEvent({session, event});

      expect(mockClient.events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            eventMetadata: expect.objectContaining({
              customMetadata: expect.objectContaining({
                _compaction: expect.any(Object),
              }),
            }),
          }),
        }),
      );
    });

    it('appends usage metadata if present', async () => {
      const session = {
        id: 's1',
        appName: '12345',
        userId: 'u1',
        events: [],
      } as unknown as Session;
      const event = createEvent({
        timestamp: Date.now(),
        content: {role: 'model', parts: []},
      });
      const eventWithUsage = event as unknown as {
        usageMetadata: object;
      };
      eventWithUsage.usageMetadata = {promptTokens: 10};

      await service.appendEvent({session, event});

      expect(mockClient.events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            eventMetadata: expect.objectContaining({
              customMetadata: expect.objectContaining({
                _usage_metadata: {promptTokens: 10},
              }),
            }),
          }),
        }),
      );
    });

    it('passes provided author and invocationId from Event', async () => {
      const session = {
        id: 'append-session',
        appName: '12345',
        userId: 'testUser',
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session;

      const event = createEvent({
        timestamp: 1620000000000,
        author: 'agent-bot',
        invocationId: 'inv-explicit-id',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });

      await service.appendEvent({session, event});

      expect(mockClient.events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          author: 'agent-bot',
          invocationId: 'inv-explicit-id',
        }),
      );
    });

    it('handles event without actions in appendEvent', async () => {
      const session = {
        id: 's1',
        appName: '12345',
        userId: 'u1',
        events: [],
      } as unknown as Session;
      const event = createEvent({
        timestamp: Date.now(),
        content: {role: 'model', parts: []},
      });
      delete (event as unknown as {actions?: object}).actions;

      await service.appendEvent({session, event});

      expect(mockClient.events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            actions: undefined,
          }),
        }),
      );
    });
  });
});
