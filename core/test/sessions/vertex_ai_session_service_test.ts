/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {
  createEvent,
  isCompactedEvent,
  State,
  VertexAiSessionService,
} from '@google/adk';
import {Session} from '@google/adk/sessions/session.js';
import {ApiError} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  isFastForwardable,
  reconstructNodeStates,
} from '../../src/workflow/utils/rehydration_utils.js';

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

const clientConstructor = vi.hoisted(() => vi.fn());

// The service imports Client from the package root, so the mock must target
// the root. Keep the other root exports for the rest of the module graph.
vi.mock('@google-cloud/vertexai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google-cloud/vertexai')>()),
  Client: class {
    readonly agentEnginesInternal = {sessions: {}};

    constructor(options: {project?: string; location?: string}) {
      clientConstructor(options);
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  clientConstructor.mockClear();
});

import {
  isVertexAiConnectionString,
  quoteFilterLiteral,
} from '@google/adk/sessions/vertex_ai_session_service.js';
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

describe('quoteFilterLiteral', () => {
  it('quotes a plain value', () => {
    expect(quoteFilterLiteral('alice')).toBe('"alice"');
  });

  it('neutralizes quote injection', () => {
    // Must not break out of the literal and append an OR predicate that would
    // return every user's sessions.
    expect(quoteFilterLiteral('attacker" OR user_id!="')).toBe(
      '"attacker\\" OR user_id!=\\""',
    );
  });

  it('escapes a lone backslash', () => {
    expect(quoteFilterLiteral('\\')).toBe('"\\\\"');
  });

  it('quotes an empty string', () => {
    expect(quoteFilterLiteral('')).toBe('""');
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
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', undefined);

    expect(() => new VertexAiSessionService({})).toThrow(
      'Project ID and Location are required.',
    );
    expect(
      () => new VertexAiSessionService({projectId: 'test-project'}),
    ).toThrow('Project ID and Location are required.');
  });

  describe('express mode', () => {
    beforeEach(() => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
      vi.stubEnv('GOOGLE_API_KEY', 'env-api-key');
    });

    it.each([
      ['an expressModeApiKey option', {expressModeApiKey: 'test-api-key'}],
      ['an API key from the environment', {}],
      ['an API key and only a project', {projectId: 'test-project'}],
    ])('throws for %s instead of dropping the key', (_, options) => {
      expect(() => new VertexAiSessionService(options)).toThrow(
        'Vertex AI Express Mode',
      );
      expect(clientConstructor).not.toHaveBeenCalled();
    });

    it('keeps using project and location when an API key is also in the environment', () => {
      new VertexAiSessionService({
        projectId: 'test-project',
        location: 'us-central1',
      });

      expect(clientConstructor).toHaveBeenCalledWith({
        project: 'test-project',
        location: 'us-central1',
      });
    });

    it('never builds a client when sessions are injected', () => {
      new VertexAiSessionService({
        sessions: mockClient as unknown as Sessions,
      });

      expect(clientConstructor).not.toHaveBeenCalled();
    });
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

    it('filters out temporary state keys prefixed with temp:', async () => {
      const session = await service.createSession({
        appName: '12345',
        userId: 'testUser',
        state: {
          foo: 'bar',
          [`${State.TEMP_PREFIX}tempKey`]: 'tempValue',
        },
      });

      expect(session.id).toBe('test-id');
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

    it('forwards ttl to the create config', async () => {
      await service.createSession({
        appName: '12345',
        userId: 'testUser',
        ttl: '7200s',
      });

      expect(mockClient.createInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/12345',
        userId: 'testUser',
        config: {ttl: '7200s'},
      });
    });

    it('forwards expireTime to the create config', async () => {
      await service.createSession({
        appName: '12345',
        userId: 'testUser',
        expireTime: '2025-10-01T00:00:00Z',
      });

      expect(mockClient.createInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/12345',
        userId: 'testUser',
        config: {expireTime: '2025-10-01T00:00:00Z'},
      });
    });

    it('throws when both ttl and expireTime are specified', async () => {
      await expect(
        service.createSession({
          appName: '12345',
          userId: 'testUser',
          ttl: '7200s',
          expireTime: '2025-10-01T00:00:00Z',
        }),
      ).rejects.toThrow(
        "Cannot specify both 'ttl' and 'expireTime' simultaneously.",
      );
      expect(mockClient.createInternal).not.toHaveBeenCalled();
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
      // `isCompacted` is declared on `CompactedEvent`, a refinement of `Event`,
      // so it is only readable after narrowing with the exported type guard
      // (which checks exactly `isCompacted === true`).
      expect(parsedEvent !== undefined && isCompactedEvent(parsedEvent)).toBe(
        true,
      );
      expect(parsedEvent?.usageMetadata).toEqual({promptTokens: 10});
    });

    it('restores groundingMetadata when rawEvent is absent', async () => {
      const groundingMetadata = {
        webSearchQueries: ['adk js sessions'],
        groundingChunks: [
          {web: {uri: 'https://example.com', title: 'Example'}},
        ],
      };
      mockClient.events.listInternal.mockResolvedValue({
        sessionEvents: [
          {
            name: 'projects/p/locations/l/sessions/s/events/e1',
            invocationId: 'inv-1',
            author: 'agent',
            content: {role: 'model', parts: [{text: 'grounded'}]},
            timestamp: '2026-04-09T13:00:00Z',
            eventMetadata: {groundingMetadata},
          },
        ],
      });

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session?.events[0].groundingMetadata).toEqual(groundingMetadata);
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

    it('returns undefined when sessions.get rejects with an ApiError 404', async () => {
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      mockClient.get.mockRejectedValueOnce(
        new ApiError({message: 'Session not found', status: 404}),
      );

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session).toBeUndefined();
      expect(loggerSpy).not.toHaveBeenCalled();
      loggerSpy.mockRestore();
    });

    it('returns undefined when events.listInternal rejects with an ApiError 404', async () => {
      mockClient.events.listInternal.mockRejectedValueOnce(
        new ApiError({message: 'Session not found', status: 404}),
      );

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session).toBeUndefined();
    });

    it('throws an ApiError 403 instead of reporting the session as missing', async () => {
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      mockClient.get.mockRejectedValueOnce(
        new ApiError({message: 'Permission denied', status: 403}),
      );

      await expect(
        service.getSession({
          appName: '12345',
          userId: 'testUser',
          sessionId: 'my-session-id',
        }),
      ).rejects.toThrow('Permission denied');
      expect(loggerSpy).toHaveBeenCalled();
      loggerSpy.mockRestore();
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
        config: {filter: 'user_id="testUser"'},
      });
      expect(response.sessions).toHaveLength(2);
      expect(response.sessions[0].id).toBe('test-list-1');
      expect(response.sessions[1].id).toBe('malformed_name');
    });

    it('escapes double quotes in userId to prevent AIP-160 filter injection', async () => {
      // A double quote in userId must not break out of the quoted filter
      // literal and append an `OR user_id!=""` predicate that would return
      // every user's sessions (cross-user session enumeration).
      mockClient.listInternal.mockResolvedValue({sessions: []});

      await service.listSessions({
        appName: '12345',
        userId: 'attacker" OR user_id!="',
      });

      expect(mockClient.listInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/12345',
        config: {filter: 'user_id="attacker\\" OR user_id!=\\""'},
      });
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

    it('returns pagination metadata with page=1 and totalPages=1 for non-empty result', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {name: 'projects/p/locations/l/sessions/s1', userId: 'testUser'},
          {name: 'projects/p/locations/l/sessions/s2', userId: 'testUser'},
        ],
      });

      const result = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
      });

      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
      expect(result.totalItems).toBe(2);
      expect(result.totalPages).toBe(1);
    });

    it('returns pagination metadata with totalPages=0 for empty result', async () => {
      mockClient.listInternal.mockResolvedValue({});

      const result = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
      });

      expect(result.sessions).toEqual([]);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(0);
      expect(result.totalItems).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('aggregates multi-page API responses into a single result with correct metadata', async () => {
      mockClient.listInternal
        .mockResolvedValueOnce({
          sessions: [
            {name: 'projects/p/locations/l/sessions/s1', userId: 'testUser'},
          ],
          nextPageToken: 'token-page-2',
        })
        .mockResolvedValueOnce({
          sessions: [
            {name: 'projects/p/locations/l/sessions/s2', userId: 'testUser'},
            {name: 'projects/p/locations/l/sessions/s3', userId: 'testUser'},
          ],
        });

      const result = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
      });

      expect(result.sessions).toHaveLength(3);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(3);
      expect(result.totalItems).toBe(3);
      expect(result.totalPages).toBe(1);
    });

    it('order asc sorts sessions by lastUpdateTime ascending', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {
            name: 'projects/p/locations/l/sessions/s3',
            userId: 'testUser',
            updateTime: '2026-01-03T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s1',
            userId: 'testUser',
            updateTime: '2026-01-01T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s2',
            userId: 'testUser',
            updateTime: '2026-01-02T00:00:00Z',
          },
        ],
      });

      const result = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
        order: 'asc',
      });

      expect(result.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    });

    it('order desc sorts sessions by lastUpdateTime descending', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {
            name: 'projects/p/locations/l/sessions/s1',
            userId: 'testUser',
            updateTime: '2026-01-01T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s3',
            userId: 'testUser',
            updateTime: '2026-01-03T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s2',
            userId: 'testUser',
            updateTime: '2026-01-02T00:00:00Z',
          },
        ],
      });

      const result = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
        order: 'desc',
      });

      expect(result.sessions.map((s) => s.id)).toEqual(['s3', 's2', 's1']);
    });

    it('limit returns correct slice and metadata', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {
            name: 'projects/p/locations/l/sessions/s1',
            userId: 'testUser',
            updateTime: '2026-01-01T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s2',
            userId: 'testUser',
            updateTime: '2026-01-02T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s3',
            userId: 'testUser',
            updateTime: '2026-01-03T00:00:00Z',
          },
        ],
      });

      const result = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
        limit: 2,
        order: 'asc',
      });

      expect(result.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(result.totalItems).toBe(3);
      expect(result.totalPages).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });

    it('page + limit returns correct slice', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {
            name: 'projects/p/locations/l/sessions/s1',
            userId: 'testUser',
            updateTime: '2026-01-01T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s2',
            userId: 'testUser',
            updateTime: '2026-01-02T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s3',
            userId: 'testUser',
            updateTime: '2026-01-03T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s4',
            userId: 'testUser',
            updateTime: '2026-01-04T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s5',
            userId: 'testUser',
            updateTime: '2026-01-05T00:00:00Z',
          },
        ],
      });

      const result = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
        page: 2,
        limit: 2,
        order: 'asc',
      });

      expect(result.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(2);
      expect(result.totalItems).toBe(5);
      expect(result.totalPages).toBe(3);
    });

    it('offset skips sessions correctly', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {
            name: 'projects/p/locations/l/sessions/s1',
            userId: 'testUser',
            updateTime: '2026-01-01T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s2',
            userId: 'testUser',
            updateTime: '2026-01-02T00:00:00Z',
          },
          {
            name: 'projects/p/locations/l/sessions/s3',
            userId: 'testUser',
            updateTime: '2026-01-03T00:00:00Z',
          },
        ],
      });

      const result = await service.listSessions({
        appName: '12345',
        userId: 'testUser',
        limit: 2,
        offset: 1,
        order: 'asc',
      });

      expect(result.sessions.map((s) => s.id)).toEqual(['s2', 's3']);
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

    it('does not delete a session that belongs to another user', async () => {
      mockClient.get.mockResolvedValue({
        name: 'reasoningEngines/12345/sessions/victim-session',
        userId: 'victimUser',
        sessionState: {},
        updateTime: new Date().toISOString(),
      });
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      await expect(
        service.deleteSession({
          appName: '12345',
          userId: 'attackerUser',
          sessionId: 'victim-session',
        }),
      ).rejects.toThrow(
        'Session victim-session does not belong to user attackerUser',
      );

      expect(mockClient.delete).not.toHaveBeenCalled();
      loggerSpy.mockRestore();
    });

    it("does not delete another user's session when userId is omitted", async () => {
      mockClient.get.mockResolvedValue({
        name: 'reasoningEngines/12345/sessions/victim-session',
        userId: 'victimUser',
        sessionState: {},
        updateTime: new Date().toISOString(),
      });
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      await expect(
        service.deleteSession({
          appName: '12345',
          userId: undefined as unknown as string,
          sessionId: 'victim-session',
        }),
      ).rejects.toThrow('does not belong to user');

      expect(mockClient.delete).not.toHaveBeenCalled();
      loggerSpy.mockRestore();
    });

    it('does not call delete when the session does not exist', async () => {
      mockClient.get.mockRejectedValue({code: 5});

      await service.deleteSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'missing-session',
      });

      expect(mockClient.delete).not.toHaveBeenCalled();
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

    describe('agent transfer action', () => {
      const transferSession = () =>
        ({
          id: 'transfer-session',
          appName: '12345',
          userId: 'testUser',
          events: [],
          lastUpdateTime: Date.now(),
        }) as unknown as Session;

      it('sends the transfer under the name the API defines', async () => {
        const event = createEvent({
          timestamp: 1620000000000,
          author: 'router',
          invocationId: 'inv-1',
          actions: {transferToAgent: 'billing_agent'},
        });

        await service.appendEvent({session: transferSession(), event});

        const sent = mockClient.events.append.mock.calls.at(-1)![0];
        expect(sent.config.actions.transferAgent).toBe('billing_agent');
        expect(sent.config.actions.transferToAgent).toBeUndefined();
      });

      it('round-trips the transfer when rawEvent is absent', async () => {
        const event = createEvent({
          timestamp: 1620000000000,
          author: 'router',
          invocationId: 'inv-1',
          actions: {transferToAgent: 'billing_agent'},
        });

        await service.appendEvent({session: transferSession(), event});
        const sent = mockClient.events.append.mock.calls.at(-1)![0];
        mockClient.events.listInternal.mockResolvedValue({
          sessionEvents: [
            {
              name: 'reasoningEngines/12345/sessions/transfer-session/events/e1',
              author: sent.author,
              invocationId: sent.invocationId,
              timestamp: sent.timestamp,
              content: sent.config.content,
              actions: sent.config.actions,
              eventMetadata: sent.config.eventMetadata,
            },
          ],
        });

        const session = await service.getSession({
          appName: '12345',
          userId: 'testUser',
          sessionId: 'transfer-session',
        });

        expect(session!.events[0].actions.transferToAgent).toBe(
          'billing_agent',
        );
      });

      it('does not mutate the caller event', async () => {
        const event = createEvent({
          timestamp: 1620000000000,
          author: 'router',
          invocationId: 'inv-1',
          actions: {transferToAgent: 'billing_agent'},
        });

        await service.appendEvent({session: transferSession(), event});

        expect(event.actions.transferToAgent).toBe('billing_agent');
        expect('transferAgent' in event.actions).toBe(false);
      });

      it('adds no transfer key when the event has none', async () => {
        const event = createEvent({
          timestamp: 1620000000000,
          author: 'agent',
          invocationId: 'inv-1',
          content: {role: 'model', parts: [{text: 'hi'}]},
        });

        await service.appendEvent({session: transferSession(), event});

        const sent = mockClient.events.append.mock.calls.at(-1)![0];
        expect('transferAgent' in sent.config.actions).toBe(false);
      });
    });

    describe('unsupported fields and fallback', () => {
      const appendSession = () =>
        ({
          id: 'append-session',
          appName: '12345',
          userId: 'testUser',
          events: [],
          lastUpdateTime: Date.now(),
        }) as unknown as Session;

      /** The request config captured by the first appendEvent call. */
      const appendedConfig = () =>
        mockClient.events.append.mock.calls[0][0].config;

      it('strips partMetadata from content and rawEvent without mutating the event', async () => {
        const event = createEvent({
          timestamp: 1620000000000,
          content: {
            role: 'user',
            parts: [
              {text: 'hello', partMetadata: {source: 'portal'}},
              {text: 'world', partMetadata: {source: 'portal'}},
            ],
          },
        });

        await service.appendEvent({session: appendSession(), event});

        const config = appendedConfig();
        expect(config.content).toEqual({
          role: 'user',
          parts: [{text: 'hello'}, {text: 'world'}],
        });
        expect(config.rawEvent?.content).toEqual({
          role: 'user',
          parts: [{text: 'hello'}, {text: 'world'}],
        });
        expect(event.content?.parts?.[0].partMetadata).toEqual({
          source: 'portal',
        });
      });

      it('handles content without parts', async () => {
        const event = createEvent({
          timestamp: 1620000000000,
          content: {role: 'user'},
        });

        await service.appendEvent({session: appendSession(), event});

        expect(appendedConfig().content).toEqual({role: 'user'});
      });

      it('handles an event without content', async () => {
        const event = createEvent({timestamp: 1620000000000});
        delete event.content;

        await service.appendEvent({session: appendSession(), event});

        const config = appendedConfig();
        expect(config.content).toBeUndefined();
        expect(config.rawEvent).not.toHaveProperty('content');
      });

      it('retries without rawEvent when the API rejects it with 400', async () => {
        const loggerSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        // The retry reuses the request object, so record what each attempt
        // actually carried instead of inspecting it afterwards.
        const sentRawEvent: boolean[] = [];
        mockClient.events.append
          .mockImplementationOnce(async (params) => {
            sentRawEvent.push(params.config?.rawEvent !== undefined);
            throw new ApiError({message: 'Unknown name', status: 400});
          })
          .mockImplementationOnce(async (params) => {
            sentRawEvent.push(params.config?.rawEvent !== undefined);
            return {};
          });
        const event = createEvent({
          timestamp: 1620000000000,
          content: {role: 'user', parts: [{text: 'hello'}]},
        });

        await service.appendEvent({session: appendSession(), event});

        expect(sentRawEvent).toEqual([true, false]);
        // Reusing the request is what keeps the retry's invocation id and
        // timestamp identical to the first attempt's.
        const [first, second] = mockClient.events.append.mock.calls;
        expect(second[0]).toBe(first[0]);
        loggerSpy.mockRestore();
      });

      it.each([
        ['a server error', new ApiError({message: 'try later', status: 503})],
        ['a network error', new Error('socket hang up')],
      ])('rethrows %s without re-appending', async (_label, failure) => {
        mockClient.events.append.mockRejectedValueOnce(failure);
        const event = createEvent({
          timestamp: 1620000000000,
          content: {role: 'user', parts: [{text: 'hello'}]},
        });

        await expect(
          service.appendEvent({session: appendSession(), event}),
        ).rejects.toBe(failure);
        expect(mockClient.events.append).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('workflow event fields', () => {
    const appendSession = () =>
      ({
        id: 'wf-session',
        appName: '12345',
        userId: 'testUser',
        events: [],
        lastUpdateTime: Date.now(),
      }) as unknown as Session;

    /**
     * Replays an API event the way the real service sees it: the request is
     * serialized on the wire, so anything that survives only by object
     * identity (a `Date`, `Map` or `Set` inside `output`) must not survive
     * here either.
     */
    const overTheWire = <T>(value: T): T =>
      JSON.parse(JSON.stringify(value)) as T;

    const readBackWithoutRawEvent = async () => {
      const sent = mockClient.events.append.mock.calls.at(-1)![0];
      const apiEvent = overTheWire({
        name: 'reasoningEngines/12345/sessions/wf-session/events/e1',
        author: sent.author,
        invocationId: sent.invocationId,
        timestamp: sent.timestamp,
        content: sent.config.content,
        actions: sent.config.actions,
        eventMetadata: sent.config.eventMetadata,
      });
      mockClient.events.listInternal.mockResolvedValue({
        sessionEvents: [apiEvent],
      });
      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'wf-session',
      });
      return {apiEvent, event: session!.events[0]};
    };

    it('writes workflow fields into customMetadata', async () => {
      const event = createEvent({
        timestamp: 1620000000000,
        author: 'reviewer',
        invocationId: 'inv-1',
        output: {score: 7},
        route: 'approved',
        nodeInfo: {path: 'wf.reviewer', messageAsOutput: true},
        isolationScope: 'wf:evt_1',
        actions: {agentState: {input: 'draft'}, endOfAgent: true},
      });

      await service.appendEvent({session: appendSession(), event});

      expect(mockClient.events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            eventMetadata: expect.objectContaining({
              customMetadata: expect.objectContaining({
                _workflow: {
                  output: {score: 7},
                  route: 'approved',
                  nodeInfo: {path: 'wf.reviewer', messageAsOutput: true},
                  isolationScope: 'wf:evt_1',
                  agentState: {input: 'draft'},
                  endOfAgent: true,
                },
              }),
            }),
          }),
        }),
      );
    });

    it('writes no workflow metadata for a plain event', async () => {
      const event = createEvent({
        timestamp: 1620000000000,
        author: 'agent',
        invocationId: 'inv-1',
        content: {role: 'model', parts: [{text: 'hi'}]},
      });

      await service.appendEvent({session: appendSession(), event});

      const sent = mockClient.events.append.mock.calls.at(-1)![0];
      expect(sent.config.eventMetadata.customMetadata).toBeUndefined();
    });

    it('restores workflow fields when rawEvent is absent', async () => {
      const original = createEvent({
        timestamp: 1620000000000,
        author: 'reviewer',
        invocationId: 'inv-1',
        output: {score: 7},
        route: 'approved',
        nodeInfo: {path: 'wf.reviewer', outputFor: ['wf.reviewer']},
        isolationScope: 'wf:evt_1',
        actions: {agentState: {input: 'draft'}, endOfAgent: true},
      });

      await service.appendEvent({session: appendSession(), event: original});
      const {event} = await readBackWithoutRawEvent();

      expect(event.output).toEqual({score: 7});
      expect(event.route).toBe('approved');
      expect(event.nodeInfo).toEqual({
        path: 'wf.reviewer',
        outputFor: ['wf.reviewer'],
      });
      expect(event.isolationScope).toBe('wf:evt_1');
      expect(event.actions.agentState).toEqual({input: 'draft'});
      expect(event.actions.endOfAgent).toBe(true);
    });

    it('round-trips a falsy output rather than dropping it', async () => {
      for (const output of [false, 0, '', null]) {
        mockClient.events.append.mockClear();
        const event = createEvent({
          timestamp: 1620000000000,
          author: 'gate',
          invocationId: 'inv-1',
          nodeInfo: {path: 'wf.gate'},
          output,
        });

        await service.appendEvent({session: appendSession(), event});
        const {event: readBack} = await readBackWithoutRawEvent();

        expect(readBack.output).toBe(output);
      }
    });

    it('keeps the workflow key out of user-visible customMetadata', async () => {
      const event = createEvent({
        timestamp: 1620000000000,
        author: 'reviewer',
        invocationId: 'inv-1',
        output: 'done',
        nodeInfo: {path: 'wf.reviewer'},
        customMetadata: {tenant: 'acme'},
      });

      await service.appendEvent({session: appendSession(), event});
      const {apiEvent, event: readBack} = await readBackWithoutRawEvent();

      expect(readBack.customMetadata).toEqual({tenant: 'acme'});
      expect(readBack.output).toBe('done');
      expect(
        (apiEvent.eventMetadata.customMetadata as Record<string, unknown>)
          ._workflow,
      ).toBeDefined();
    });

    it('lets a resumed workflow rehydrate from reconstructed events', async () => {
      const completed = createEvent({
        timestamp: 1620000000000,
        author: 'fetch',
        invocationId: 'inv-1',
        nodeInfo: {path: 'wf.fetch'},
        output: 'A(x)',
      });
      const paused = createEvent({
        timestamp: 1620000001000,
        author: 'gate',
        invocationId: 'inv-1',
        nodeInfo: {path: 'wf.gate'},
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'adk_request_input', id: 'gate-1'}}],
        },
        longRunningToolIds: ['gate-1'],
        actions: {agentState: {input: 'A(x)'}},
      });

      const apiEvents = [];
      for (const event of [completed, paused]) {
        mockClient.events.append.mockClear();
        await service.appendEvent({session: appendSession(), event});
        const sent = mockClient.events.append.mock.calls.at(-1)![0];
        apiEvents.push(
          overTheWire({
            name: `reasoningEngines/12345/sessions/wf-session/events/${apiEvents.length}`,
            author: sent.author,
            invocationId: sent.invocationId,
            timestamp: sent.timestamp,
            content: sent.config.content,
            actions: sent.config.actions,
            eventMetadata: sent.config.eventMetadata,
          }),
        );
      }
      mockClient.events.listInternal.mockResolvedValue({
        sessionEvents: apiEvents,
      });

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'wf-session',
      });

      const states = reconstructNodeStates(session!.events, 'wf');
      expect(states.get('fetch')?.output).toBe('A(x)');
      expect(isFastForwardable(states.get('fetch')!)).toBe(true);
      expect([...states.get('gate')!.interruptIds]).toEqual(['gate-1']);
      expect(states.get('gate')?.input).toBe('A(x)');
    });
  });

  describe('legacy read path', () => {
    it('restores transferToAgent from a legacy transferToAgent key', async () => {
      // Sessions written by earlier adk-js versions stored ADK's own
      // `transferToAgent` key rather than the API's `transferAgent`.
      mockClient.events.listInternal.mockResolvedValue({
        sessionEvents: [
          {
            name: 'reasoningEngines/12345/sessions/s/events/e1',
            author: 'model',
            actions: {transferToAgent: 'legacy-specialist'},
          },
        ],
      });

      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session?.events).toHaveLength(1);
      expect(session!.events[0].actions.transferToAgent).toBe(
        'legacy-specialist',
      );
    });
  });
});
