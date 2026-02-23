/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session, createSession} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AdkApiClient} from '../../src/server/adk_api_client.js';

describe('AdkApiClient', () => {
  const mockBackendUrl = 'http://localhost:3000';
  let client: AdkApiClient;

  beforeEach(() => {
    client = new AdkApiClient({backendUrl: mockBackendUrl});
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listApps', () => {
    it('should list apps successfully', async () => {
      const mockApps = ['app1', 'app2'];
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockApps,
      });

      const result = await client.listApps();

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/list-apps`,
        undefined,
      );
      expect(result).toEqual(mockApps);
    });

    it('should throw error on failure', async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({error: 'Internal Server Error'}),
      });

      await expect(client.listApps()).rejects.toThrow('Internal Server Error');
    });
  });

  describe('getSession', () => {
    it('should get session successfully', async () => {
      const mockSession = createSession({
        id: 'session1',
        appName: 'app1',
        userId: 'user1',
        state: {},
      });
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockSession,
      });

      const result = await client.getSession({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions/session1`,
        {
          method: 'GET',
          headers: {'Content-Type': 'application/json'},
        },
      );
      expect(result).toEqual(mockSession);
    });
  });

  describe('createSession', () => {
    it('should create session successfully without sessionId', async () => {
      const mockSession = createSession({
        id: 'session1',
        appName: 'app1',
        userId: 'user1',
        state: {key: 'value'},
      });
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockSession,
      });

      const result = await client.createSession({
        appName: 'app1',
        userId: 'user1',
        state: {key: 'value'},
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({state: {key: 'value'}}),
        },
      );
      expect(result).toEqual(mockSession);
    });

    it('should create session successfully with sessionId', async () => {
      const mockSession = createSession({
        id: 'session1',
        appName: 'app1',
        userId: 'user1',
        state: {},
      });
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockSession,
      });

      const result = await client.createSession({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions/session1`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({state: undefined}),
        },
      );
      expect(result).toEqual(mockSession);
    });
  });

  describe('deleteSession', () => {
    it('should delete session successfully', async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => {},
      });

      await client.deleteSession({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions/session1`,
        {
          method: 'DELETE',
          headers: {'Content-Type': 'application/json'},
        },
      );
    });
  });

  describe('listSessions', () => {
    it('should list sessions successfully (array response)', async () => {
      const mockSessions = [
        createSession({id: 's1', appName: 'a1', userId: 'u1', state: {}}),
      ];
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockSessions,
      });

      const result = await client.listSessions({
        appName: 'app1',
        userId: 'user1',
      });

      expect(result).toEqual(mockSessions);
    });

    it('should list sessions successfully (object response)', async () => {
      const mockSessions: Session[] = [
        createSession({id: 's1', appName: 'a1', userId: 'u1', state: {}}),
      ];
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({sessions: mockSessions}),
      });

      const result = await client.listSessions({
        appName: 'app1',
        userId: 'user1',
      });

      expect(result).toEqual(mockSessions);
    });
  });

  describe('listAllSessions', () => {
    it('should list all sessions across apps', async () => {
      const mockApps = ['app1', 'app2'];
      const mockSessionsApp1 = [
        {id: 's1', appName: 'app1', userId: 'user1', state: {}},
      ];
      const mockSessionsApp2 = [
        {id: 's2', appName: 'app2', userId: 'user1', state: {}},
      ];

      // Mock listApps call
      (global.fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockApps,
        })
        // Mock listSessions call for app1
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockSessionsApp1,
        })
        // Mock listSessions call for app2
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockSessionsApp2,
        });

      const result = await client.listAllSessions({userId: 'user1'});

      expect(result).toHaveLength(2);
      expect(result).toEqual([...mockSessionsApp1, ...mockSessionsApp2]);
    });
  });

  describe('run', () => {
    it('should handle SSE stream successfully', async () => {
      const mockEvent1 = {type: 'event1'};
      const mockEvent2 = {type: 'event2'};
      const streamBody = `data: ${JSON.stringify(mockEvent1)}\n\ndata: ${JSON.stringify(mockEvent2)}\n\n`;

      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode(streamBody),
          })
          .mockResolvedValueOnce({done: true, value: undefined}),
      };

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        body: {
          getReader: () => mockReader,
        },
      });

      const events = [];
      for await (const event of client.runAsync({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
        streaming: true,
        stateDelta: {},
      })) {
        events.push(event);
      }

      expect(events).toEqual([mockEvent1, mockEvent2]);
    });

    it('should handle string message in run', async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({done: true, value: undefined}),
          }),
        },
      });

      await client
        .runAsync({
          appName: 'app1',
          userId: 'user1',
          sessionId: 'session1',
          newMessage: 'hello string',
          streaming: true,
          stateDelta: {},
        })
        .next();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/run_sse'),
        expect.objectContaining({
          body: expect.stringContaining('"parts":[{"text":"hello string"}]'),
        }),
      );
    });

    it('should throw error on stream error', async () => {
      const errorMsg = 'Stream Error';
      const streamBody = `data: {"error": "${errorMsg}"}\n\n`;
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode(streamBody),
          })
          .mockResolvedValueOnce({done: true, value: undefined}),
      };

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        body: {
          getReader: () => mockReader,
        },
      });

      await expect(async () => {
        for await (const _ of client.runAsync({
          appName: 'app1',
          userId: 'user1',
          sessionId: 'session1',
          newMessage: {role: 'user', parts: [{text: 'hello'}]},
          streaming: true,
          stateDelta: {},
        })) {
          // do nothing
        }
      }).rejects.toThrow(errorMsg);
    });
  });

  describe('listArtifacts', () => {
    it('should list artifacts successfully', async () => {
      const mockArtifacts = [{filename: 'file1.txt'}];
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockArtifacts,
      });

      const result = await client.listArtifacts({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions/session1/artifacts`,
        {
          method: 'GET',
          headers: {'Content-Type': 'application/json'},
        },
      );
      expect(result).toEqual(mockArtifacts);
    });
  });

  describe('loadArtifact', () => {
    it('should load artifact successfully', async () => {
      const mockContent = 'artifact content';
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockContent,
      });

      const result = await client.loadArtifact({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        artifactName: 'file1.txt',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions/session1/artifacts/file1.txt`,
        {
          method: 'GET',
          headers: {'Content-Type': 'application/json'},
        },
      );
      expect(result).toEqual(mockContent);
    });

    it('should load artifact version successfully', async () => {
      const mockContent = 'artifact content v1';
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockContent,
      });

      const result = await client.loadArtifact({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        artifactName: 'file1.txt',
        version: 1,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions/session1/artifacts/file1.txt/versions/1`,
        {
          method: 'GET',
          headers: {'Content-Type': 'application/json'},
        },
      );
      expect(result).toEqual(mockContent);
    });
  });

  describe('listArtifactVersions', () => {
    it('should list artifact versions successfully', async () => {
      const mockVersions = [1, 2, 3];
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockVersions,
      });

      const result = await client.listArtifactVersions({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        artifactName: 'file1.txt',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions/session1/artifacts/file1.txt/versions`,
        {
          method: 'GET',
          headers: {'Content-Type': 'application/json'},
        },
      );
      expect(result).toEqual(mockVersions);
    });
  });

  describe('deleteArtifact', () => {
    it('should delete artifact successfully', async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => {},
      });

      await client.deleteArtifact({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        artifactName: 'file1.txt',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBackendUrl}/apps/app1/users/user1/sessions/session1/artifacts/file1.txt`,
        {
          method: 'DELETE',
          headers: {'Content-Type': 'application/json'},
        },
      );
    });
  });
});
