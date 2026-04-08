/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent} from '@google/adk';
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

import {
  isVertexAiSessionServiceConnectionString,
  VertexAiSessionService,
} from '../../src/sessions/vertex_ai_session_service.js';
import {logger} from '../../src/utils/logger.js';

describe('isVertexAiSessionServiceConnectionString', () => {
  it('returns true for vertexai://', () => {
    expect(isVertexAiSessionServiceConnectionString('vertexai://projects/abc')).toBe(true);
  });

  it('returns false for other strings', () => {
    expect(isVertexAiSessionServiceConnectionString('postgres://localhost:5432')).toBe(false);
    expect(isVertexAiSessionServiceConnectionString('memory:/')).toBe(false);
    expect(isVertexAiSessionServiceConnectionString('')).toBe(false);
    expect(isVertexAiSessionServiceConnectionString(undefined)).toBe(false);
  });
});

describe('VertexAiSessionService', () => {
  let service: VertexAiSessionService;
  let mockClient: any;

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
          updateTime: new Date().toISOString(),
        },
      }),
      get: vi.fn().mockResolvedValue({
        userId: 'testUser',
        sessionState: {},
        updateTime: new Date().toISOString(),
      }),
      listInternal: vi.fn().mockResolvedValue({
        sessions: [
          {name: 'projects/p/locations/l/sessions/test-list-1', userId: 'testUser'},
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
      client: mockClient,
    });
  });

  it('can initialize without passing a client explicitly', () => {
    const defaultService = new VertexAiSessionService({
      projectId: 'test-project',
      location: 'us-central1',
    });
    expect(defaultService).toBeDefined();
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

    it('throws an error if sessionId is provided', async () => {
      await expect(
        service.createSession({
          appName: '12345',
          userId: 'testUser',
          sessionId: 'user-provided-id',
        })
      ).rejects.toThrow('User-provided Session id is not supported');
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

    it('returns undefined if session does not exist (code 5)', async () => {
      mockClient.get.mockRejectedValueOnce({code: 5, message: 'Not found'});
      
      const session = await service.getSession({
        appName: '12345',
        userId: 'testUser',
        sessionId: 'my-session-id',
      });

      expect(session).toBeUndefined();
    });

    it('throws error and logs it if error is not NOT_FOUND', async () => {
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      mockClient.get.mockRejectedValueOnce({code: 9, message: 'Permission Denied'});
      
      await expect(
        service.getSession({
          appName: '12345',
          userId: 'testUser',
          sessionId: 'my-session-id',
        })
      ).rejects.toThrow('Permission Denied');
      expect(loggerSpy).toHaveBeenCalled();
    });
  });

  describe('listSessions', () => {
    it('returns list of sessions parsing name extracts', async () => {
      mockClient.listInternal.mockResolvedValue({
        sessions: [
          {name: 'projects/p/locations/l/sessions/test-list-1', userId: 'testUser'},
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
      } as any;
      
      const event = createEvent({
        timestamp: 1620000000000,
        author: undefined,
        invocationId: '',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });

      const realDateNow = Date.now;
      (globalThis as any).Date.now = () => 1700000000000;

      await service.appendEvent({session, event});
      (globalThis as any).Date.now = realDateNow;

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
            escalate: undefined,
            requestedAuthConfigs: {},
            skipSummarization: undefined,
            stateDelta: {},
            transferAgent: undefined,
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
        },
      });
    });

    it('passes provided author and invocationId from Event', async () => {
      const session = {
        id: 'append-session',
        appName: '12345',
        userId: 'testUser',
        events: [],
        lastUpdateTime: Date.now(),
      } as any;
      
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
        })
      );
    });
  });
});
