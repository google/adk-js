/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BaseArtifactService} from '../../src/artifacts/base_artifact_service.js';

/**
 * Runs the shared artifact service tests.
 *
 * @param createService A function that returns a promise that resolves to the artifact service.
 * @param cleanup A function that returns a promise that cleans up the artifact service.
 * @param suiteName The name of the test suite.
 */
export function runArtifactServiceTests(
  createService: () => Promise<BaseArtifactService>,
  cleanup: () => Promise<void>,
) {
  let service: BaseArtifactService;
  const appName = 'test-app';
  const userId = 'test-user';
  const sessionId = 'test-session';

  beforeEach(async () => {
    service = await createService();
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('saveArtifact', () => {
    it('saves a text artifact', async () => {
      const filename = 'test.txt';
      const text = 'hello world';
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text},
      });

      expect(version).toBe(0);
      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(loaded?.text).toBe(text);
    });

    it('saves a binary artifact', async () => {
      const filename = 'test.png';
      const data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgDNjd8qAAAAAElFTkSuQmCC';
      const mimeType = 'image/png';
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {inlineData: {data, mimeType}},
      });

      expect(version).toBe(0);
      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(loaded?.inlineData?.data).toBe(data);
      expect(loaded?.inlineData?.mimeType).toBe(mimeType);
    });

    it('saves user-scoped artifact', async () => {
      const filename = 'user:test.txt';
      const text = 'user scoped';
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text},
      });

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version,
      });
      expect(loaded?.text).toBe(text);
    });

    it('throws error if artifact has no content', async () => {
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'test.txt',
          artifact: {} as unknown as Part,
        }),
      ).rejects.toThrow('Artifact must have either inlineData or text');
    });

    it('increments version number', async () => {
      const filename = 'test.txt';
      const version1 = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v1'},
      });
      expect(version1).toBe(0);

      const version2 = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v2'},
      });
      expect(version2).toBe(1);
    });
  });

  describe('loadArtifact', () => {
    it('returns undefined for non-existent artifact', async () => {
      const result = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename: 'nonexistent.txt',
      });
      expect(result).toBeUndefined();
    });

    it('loads specific version', async () => {
      const filename = 'history.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v0'},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v1'},
      });

      const v0 = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(v0?.text).toBe('v0');

      const v1 = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 1,
      });
      expect(v1?.text).toBe('v1');

      const v = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(v?.text).toBe('v1');
    });
  });

  describe('listArtifactKeys', () => {
    it('lists artifacts for session and user', async () => {
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'session.txt',
        artifact: {text: '.'},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'nested/dir/session.txt',
        artifact: {text: '.'},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'user:user.txt',
        artifact: {text: '.'},
      });

      const keys = await service.listArtifactKeys({
        appName,
        userId,
        sessionId,
      });
      expect(keys).toContain('session.txt');
      expect(keys).toContain('nested/dir/session.txt');
      expect(keys).toContain('user:user.txt');
    });
  });

  describe('deleteArtifact', () => {
    it('deletes an artifact', async () => {
      const filename = 'del.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '.'},
      });
      await service.deleteArtifact({appName, userId, sessionId, filename});

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(loaded).toBeUndefined();
    });

    it('does not fail when deleting non-existent artifact', async () => {
      await service.deleteArtifact({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
    });
  });

  describe('listVersions', () => {
    it('lists versions', async () => {
      const filename = 'vers.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '1'},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '2'},
      });

      const versions = await service.listVersions({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(versions).toEqual([0, 1]);
    });

    it('returns empty list for non-existent artifact', async () => {
      const versions = await service.listVersions({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
      expect(versions).toEqual([]);
    });
  });

  describe('customMetadata', () => {
    it('saves and retrieves custom metadata', async () => {
      const filename = 'meta.txt';
      const customMetadata = {foo: 'bar', baz: 123};
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'meta'},
        customMetadata,
      });

      const versionMetadata = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version,
      });

      expect(versionMetadata).toBeDefined();
      expect(versionMetadata?.customMetadata).toEqual(customMetadata);
    });
  });

  describe('listArtifactVersions', () => {
    it('lists artifact versions with metadata', async () => {
      const filename = 'vers-meta.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '1'},
        customMetadata: {v: 1},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '2'},
        customMetadata: {v: 2},
      });

      const versions = await service.listArtifactVersions({
        appName,
        userId,
        sessionId,
        filename,
      });

      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(0);
      expect(versions[0].customMetadata).toEqual({v: 1});
      expect(versions[1].version).toBe(1);
      expect(versions[1].customMetadata).toEqual({v: 2});
    });

    it('returns empty list for non-existent artifact', async () => {
      const versions = await service.listArtifactVersions({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
      expect(versions).toHaveLength(0);
    });
  });

  describe('getArtifactVersion', () => {
    it('gets specific artifact version metadata', async () => {
      const filename = 'get-vers.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '1'},
        customMetadata: {v: 1},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '2'},
        customMetadata: {v: 2},
      });

      const v0 = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(v0?.customMetadata).toEqual({v: 1});

      const v1 = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version: 1,
      });
      expect(v1?.customMetadata).toEqual({v: 2});

      const latest = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(latest?.customMetadata).toEqual({v: 2});
    });

    it('returns undefined for non-existent version', async () => {
      const filename = 'missing-vers.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '1'},
      });

      const missing = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version: 99,
      });
      expect(missing).toBeUndefined();
    });

    it('returns undefined for non-existent artifact', async () => {
      const missing = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
      expect(missing).toBeUndefined();
    });
  });
}
