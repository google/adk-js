/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {FileArtifactService} from '../../src/artifacts/file_artifact_service.js';

describe('FileArtifactService', () => {
  let rootDir: string;
  let service: FileArtifactService;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
    service = new FileArtifactService(rootDir);
    await service.init();
  });

  afterEach(async () => {
    await fs.rm(rootDir, {recursive: true, force: true});
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

      // Verify directory structure (approximate)
      const userArtifactsDir = path.join(rootDir, 'users', userId, 'artifacts');
      const stats = await fs.stat(userArtifactsDir);
      expect(stats.isDirectory()).toBe(true);
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
  });

  describe('path security', () => {
    it('rejects traversal attempts', async () => {
      try {
        await service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: '../../secret.txt',
          artifact: {text: '.'},
        });
        expect.fail('Should have thrown');
      } catch (e: unknown) {
        expect((e as Error).message).to.contain('escapes storage directory');
      }
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
  });
});
