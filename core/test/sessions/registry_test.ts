/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DatabaseSessionService,
  type DatabaseSessionServiceOptions,
  InMemorySessionService,
  VertexAiSessionService,
  createEvent,
  getSessionServiceFromUri,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('Registry', () => {
  describe('getSessionServiceFromUri', () => {
    it('should return InMemorySessionService for "memory://" uri', () => {
      const service = getSessionServiceFromUri('memory://');
      expect(service).to.be.instanceOf(InMemorySessionService);
    });

    it('should return DatabaseSessionService with forwarded options for a database uri', async () => {
      const initSpy = vi.spyOn(MikroORM, 'init');
      try {
        const sessionDbOptions: DatabaseSessionServiceOptions = {
          debug: false,
          allowGlobalContext: true,
          staleSession: 'reload',
        };
        const service = getSessionServiceFromUri(
          'sqlite:///:memory:',
          sessionDbOptions,
        );
        expect(service).to.be.instanceOf(DatabaseSessionService);

        const key = {
          appName: 'registryApp',
          userId: 'user-1',
          sessionId: 'session-1',
        };
        const session = await service.createSession(key);
        const concurrentSession = await service.getSession(key);
        expect(concurrentSession).toBeDefined();
        if (concurrentSession) {
          await service.appendEvent({
            session: concurrentSession,
            event: createEvent({timestamp: Date.now() + 10}),
          });
        }
        await expect(
          service.appendEvent({
            session,
            event: createEvent({timestamp: Date.now() + 20}),
          }),
        ).resolves.toBeDefined();

        expect(initSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            dbName: ':memory:',
            debug: false,
            allowGlobalContext: true,
          }),
        );
        const orm = await initSpy.mock.results[0]?.value;
        await orm?.close();
      } finally {
        initSpy.mockRestore();
      }
    });

    it('should throw error for unsupported uri', () => {
      expect(() =>
        getSessionServiceFromUri('unsupported://localhost:5432/mydb'),
      ).to.throw(
        'Unsupported session service URI: unsupported://localhost:5432/mydb',
      );
    });

    describe('for "vertexai://" uri', () => {
      const originalEnv = {...process.env};

      beforeEach(() => {
        delete process.env.GOOGLE_CLOUD_PROJECT;
        delete process.env.GOOGLE_CLOUD_LOCATION;
        delete process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID;
      });

      afterEach(() => {
        process.env = {...originalEnv};
      });

      it('should configure project, location, and agent engine ID from the environment', () => {
        process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
        process.env.GOOGLE_CLOUD_LOCATION = 'test-location';
        process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID = '1234567890';

        const service = getSessionServiceFromUri('vertexai://');

        expect(service).to.be.instanceOf(VertexAiSessionService);
        expect(
          (service as unknown as Record<string, unknown>).projectId,
        ).to.equal('test-project');
        expect(
          (service as unknown as Record<string, unknown>).location,
        ).to.equal('test-location');
        expect(
          (service as unknown as Record<string, unknown>).agentEngineId,
        ).to.equal('1234567890');
      });
    });
  });
});
