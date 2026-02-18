/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryArtifactService} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

describe('InMemoryArtifactService', () => {
  let service: InMemoryArtifactService;

  beforeEach(() => {
    service = new InMemoryArtifactService();
  });

  const appName = 'test-app';
  const userId = 'test-user';
  const sessionId = 'test-session';

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

      expect(version).to.equal(0);
      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(loaded?.text).to.equal(text);
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

      expect(version).to.equal(0);
      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(loaded?.inlineData?.data).to.equal(data);
      expect(loaded?.inlineData?.mimeType).to.equal(mimeType);
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
      expect(loaded?.text).to.equal(text);
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
      expect(v0?.text).to.equal('v0');

      const v1 = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 1,
      });
      expect(v1?.text).to.equal('v1');

      const v = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(v?.text).to.equal('v1');
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

      const keys = await service.listArtifactKeys({appName, userId, sessionId});
      expect(keys).to.include('session.txt');
      expect(keys).to.include('nested/dir/session.txt');
      expect(keys).to.include('user:user.txt');
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
      expect(versions).to.deep.equal([0, 1]);
    });

    it('returns empty list for non-existent artifact', async () => {
      const versions = await service.listVersions({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
      expect(versions).to.deep.equal([]);
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
});
