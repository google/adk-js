/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GcsArtifactService} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
  const file = {
    save: vi.fn(),
    download: vi.fn(),
    getMetadata: vi.fn(),
    delete: vi.fn(),
    publicUrl: vi.fn(),
    name: 'mock-file',
  };
  const bucket = {
    file: vi.fn(() => file),
    getFiles: vi.fn(),
  };
  const storage = {
    bucket: vi.fn(() => bucket),
  };
  return {
    Storage: vi.fn(() => storage),
    storage,
    bucket,
    file,
  };
});

vi.mock('@google-cloud/storage', () => {
  return {
    Storage: mocks.Storage,
  };
});

describe('GcsArtifactService', () => {
  let service: GcsArtifactService;
  const {bucket, file} = mocks;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new GcsArtifactService('test-bucket');

    // Re-apply mocks after reset
    file.save.mockResolvedValue(undefined);
    file.delete.mockResolvedValue(undefined);
    file.publicUrl.mockReturnValue('https://example.com/artifact');
    file.getMetadata.mockResolvedValue([{}]);
    file.download.mockResolvedValue([Buffer.from('')]);
    bucket.file.mockReturnValue(file);
    bucket.getFiles.mockResolvedValue([[]]);
  });

  const appName = 'test-app';
  const userId = 'test-user';
  const sessionId = 'test-session';

  describe('saveArtifact', () => {
    it('saves a text artifact', async () => {
      const filename = 'test.txt';
      const text = 'hello world';

      // Mock no existing versions
      bucket.getFiles.mockResolvedValueOnce([[]]);

      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text},
      });

      expect(version).toBe(0);
      expect(bucket.file).toHaveBeenCalledWith(
        expect.stringContaining(`${filename}/0`),
      );
      expect(file.save).toHaveBeenCalledWith(
        text,
        expect.objectContaining({
          contentType: 'text/plain',
          metadata: {},
        }),
      );
    });

    it('saves a binary artifact', async () => {
      const filename = 'test.png';
      const data = 'base64data';
      const mimeType = 'image/png';

      bucket.getFiles.mockResolvedValueOnce([[]]);

      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {inlineData: {data, mimeType}},
      });

      expect(version).toBe(0);
      expect(file.save).toHaveBeenCalledWith(
        JSON.stringify(data),
        expect.objectContaining({
          contentType: mimeType,
        }),
      );
    });

    it('increments version number', async () => {
      const filename = 'test.txt';

      // Mock existing version 0
      bucket.getFiles.mockResolvedValueOnce([[{name: `.../${filename}/0`}]]);

      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'new version'},
      });

      expect(version).toBe(1);
      expect(bucket.file).toHaveBeenCalledWith(
        expect.stringContaining(`${filename}/1`),
      );
    });

    it('throws error if artifact has no content', async () => {
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'test.txt',
          artifact: {} as Record<string, unknown>,
        }),
      ).rejects.toThrow('Artifact must have either inlineData or text');
    });
  });

  describe('loadArtifact', () => {
    it('loads text artifact', async () => {
      const filename = 'test.txt';
      const text = 'hello world';

      bucket.getFiles.mockResolvedValueOnce([[{name: `.../${filename}/0`}]]);

      file.getMetadata.mockResolvedValue([{contentType: 'text/plain'}]);
      file.download.mockResolvedValue([Buffer.from(text)]);

      const part = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });

      expect(part).toEqual({text});
      expect(bucket.file).toHaveBeenCalledWith(
        expect.stringContaining(`${filename}/0`),
      );
    });

    it('loads binary artifact', async () => {
      const filename = 'test.png';
      const data = 'base64data';
      const mimeType = 'image/png';

      bucket.getFiles.mockResolvedValueOnce([[{name: `.../${filename}/0`}]]);

      file.getMetadata.mockResolvedValue([{contentType: mimeType}]);
      file.download.mockResolvedValue([Buffer.from(data)]);

      const part = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });

      expect(part).toEqual({
        inlineData: {
          data: Buffer.from(data).toString('base64'),
          mimeType,
        },
      });
    });

    it('returns undefined if no versions found', async () => {
      bucket.getFiles.mockResolvedValueOnce([[]]);

      const part = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename: 'missing.txt',
      });

      expect(part).toBeUndefined();
    });

    it('loads latest version if version not specified', async () => {
      const filename = 'test.txt';

      bucket.getFiles.mockResolvedValueOnce([
        [{name: `.../${filename}/0`}, {name: `.../${filename}/1`}],
      ]);

      file.getMetadata.mockResolvedValue([{contentType: 'text/plain'}]);
      file.download.mockResolvedValue([Buffer.from('v1')]);

      await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });

      expect(bucket.file).toHaveBeenCalledWith(
        expect.stringContaining(`${filename}/1`),
      );
    });
  });

  describe('listArtifactKeys', () => {
    it('lists and sorts keys from session and user scopes', async () => {
      // sessionPrefix files
      const sessionFiles = [
        {name: `path/to/${sessionId}/file1.txt`},
        {name: `path/to/${sessionId}/file2.txt`},
      ];
      // userPrefix files
      const userFiles = [{name: `path/to/user/file3.txt`}];

      bucket.getFiles
        .mockResolvedValueOnce([sessionFiles])
        .mockResolvedValueOnce([userFiles]);

      const keys = await service.listArtifactKeys({
        appName,
        userId,
        sessionId,
      });

      expect(keys).toEqual(['file1.txt', 'file2.txt', 'file3.txt']);
      expect(bucket.getFiles).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteArtifact', () => {
    it('deletes all versions of an artifact', async () => {
      const filename = 'test.txt';

      bucket.getFiles.mockResolvedValueOnce([
        [{name: `.../${filename}/0`}, {name: `.../${filename}/1`}],
      ]);

      await service.deleteArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });

      expect(bucket.file).toHaveBeenCalledWith(
        expect.stringContaining(`${filename}/0`),
      );
      expect(bucket.file).toHaveBeenCalledWith(
        expect.stringContaining(`${filename}/1`),
      );
      expect(file.delete).toHaveBeenCalledTimes(2);
    });
  });

  describe('listVersions', () => {
    it('lists versions', async () => {
      const filename = 'test.txt';

      bucket.getFiles.mockResolvedValueOnce([
        [{name: `.../${filename}/0`}, {name: `.../${filename}/2`}],
      ]);

      const versions = await service.listVersions({
        appName,
        userId,
        sessionId,
        filename,
      });

      expect(versions).toEqual([0, 2]);
      expect(bucket.getFiles).toHaveBeenCalledWith({
        prefix: `${appName}/${userId}/${sessionId}/${filename}`,
      });
    });
  });

  describe('listArtifactVersions', () => {
    it('lists artifact versions with metadata', async () => {
      const filename = 'test.txt';

      // Mock listVersions
      bucket.getFiles.mockResolvedValueOnce([[{name: `.../${filename}/0`}]]);

      // Mock getMetadata for getArtifactVersion
      file.getMetadata.mockResolvedValue([
        {
          contentType: 'text/plain',
          metadata: {foo: 'bar'},
        },
      ]);
      file.publicUrl.mockReturnValue('http://url');

      const versions = await service.listArtifactVersions({
        appName,
        userId,
        sessionId,
        filename,
      });

      expect(versions).toHaveLength(1);
      expect(versions[0]).toEqual({
        version: 0,
        mimeType: 'text/plain',
        customMetadata: {foo: 'bar'},
        canonicalUri: 'http://url',
      });
    });
  });

  describe('getArtifactVersion', () => {
    it('gets specific version metadata', async () => {
      const filename = 'test.txt';

      file.getMetadata.mockResolvedValue([
        {
          contentType: 'text/plain',
          metadata: {foo: 'bar'},
        },
      ]);
      file.publicUrl.mockReturnValue('http://url');

      const version = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });

      expect(version).toEqual({
        version: 0,
        mimeType: 'text/plain',
        customMetadata: {foo: 'bar'},
        canonicalUri: 'http://url',
      });
    });

    it('gets latest version metadata', async () => {
      const filename = 'test.txt';

      bucket.getFiles.mockResolvedValueOnce([[{name: `.../${filename}/5`}]]);

      file.getMetadata.mockResolvedValue([
        {
          contentType: 'text/plain',
        },
      ]);

      const version = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
      });

      expect(version?.version).toBe(5);
    });

    it('returns undefined if no versions', async () => {
      bucket.getFiles.mockResolvedValueOnce([[]]);

      const version = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename: 'missing.txt',
      });

      expect(version).toBeUndefined();
    });
  });
});
