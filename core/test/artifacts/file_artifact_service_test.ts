/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileArtifactService} from '@google/adk';
import {Part} from '@google/genai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {
  assertInsideRoot,
  getSessionArtifactsDir,
  getUserRoot,
} from '../../src/artifacts/file_artifact_service.js';
import {InputValidationError} from '../../src/errors/input_validation_error.js';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

describe('FileArtifactService', () => {
  let rootDir: string;

  runArtifactServiceTests(
    async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      await fs.mkdir(rootDir, {recursive: true});
      return new FileArtifactService(rootDir);
    },
    async () => {
      if (rootDir) {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    },
  );

  describe('reserved metadata filenames', () => {
    const key = {appName: 'app', userId: 'user', sessionId: 'session'};

    it.each([
      'metadata.json',
      'Metadata.JSON',
      'nested/metadata.json',
      'user:metadata.json',
      'METADATA.JSON. ',
      'nested/metadata.json...',
      'private-sentinel/metadata.json',
    ])('rejects saving %s before creating any files', async (filename) => {
      const service = new FileArtifactService(rootDir);
      const artifacts: Part[] = [
        {text: 'hello'},
        {inlineData: {data: 'aGVsbG8=', mimeType: 'text/plain'}},
        {fileData: {fileUri: 'gs://bucket/report'}},
      ];
      for (const artifact of artifacts) {
        const failure = service.saveArtifact({...key, filename, artifact});
        await expect(failure).rejects.toBeInstanceOf(InputValidationError);
        await expect(failure).rejects.toThrow('reserved for version metadata');
        await expect(failure).rejects.not.toThrow('private-sentinel');
      }
      expect(await fs.readdir(rootDir)).toEqual([]);
    });

    it.each([
      'note.json',
      'metadata.json.txt',
      'nested/metadata.json/report.txt',
    ])('keeps the standard payload layout for %s', async (filename) => {
      const service = new FileArtifactService(rootDir);
      const artifactKey = {...key, filename};
      await service.saveArtifact({...artifactKey, artifact: {text: 'hello'}});
      expect(await service.loadArtifact(artifactKey)).toEqual({text: 'hello'});
      const metadata = await service.getArtifactVersion(artifactKey);
      expect(metadata).not.toHaveProperty('contentFileName');
      expect(
        metadata?.canonicalUri?.endsWith('/' + path.basename(filename)),
      ).toBe(true);
    });

    it.each(['metadata.json', 'nested/Metadata.JSON', 'user:metadata.json'])(
      'allows reading, listing and deleting legacy %s records',
      async (filename) => {
        const userRoot = getUserRoot(rootDir, key.userId);
        const scopeRoot = filename.startsWith('user:')
          ? path.join(userRoot, 'artifacts')
          : getSessionArtifactsDir(userRoot, key.sessionId);
        const versionDir = path.join(
          scopeRoot,
          filename.replace(/^user:/, ''),
          'versions',
          '0',
        );
        await fs.mkdir(versionDir, {recursive: true});
        const metadata = {
          fileName: filename,
          version: 0,
          fileUri: 'gs://bucket/legacy',
          mimeType: 'text/plain',
        };
        await fs.writeFile(
          path.join(versionDir, 'metadata.json'),
          JSON.stringify(metadata),
        );
        const service = new FileArtifactService(rootDir);
        const artifactKey = {...key, filename};
        expect(await service.loadArtifact(artifactKey)).toEqual({
          fileData: {fileUri: metadata.fileUri, mimeType: metadata.mimeType},
        });
        expect(await service.listArtifactKeys(key)).toEqual([filename]);
        expect(await service.listVersions(artifactKey)).toEqual([0]);
        expect(await service.getArtifactVersion(artifactKey)).toEqual(metadata);
        expect(await service.listArtifactVersions(artifactKey)).toEqual([
          metadata,
        ]);
        await service.deleteArtifact(artifactKey);
        expect(await service.listArtifactKeys(key)).toEqual([]);
      },
    );
  });

  describe('fileData storage', () => {
    it('stores fileData as a metadata-only pointer with no content file', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);
      const appName = 'test-app';
      const userId = 'test-user';
      const sessionId = 'test-session';

      try {
        await service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'report.pdf',
          artifact: {
            fileData: {
              fileUri: 'gs://my-bucket/report.pdf',
              mimeType: 'application/pdf',
            },
          },
        });

        const versionDir = path.join(
          getSessionArtifactsDir(getUserRoot(rootDir, userId), sessionId),
          'report.pdf',
          'versions',
          '0',
        );
        const entries = await fs.readdir(versionDir);

        expect(entries).toEqual(['metadata.json']);

        const loaded = await service.loadArtifact({
          appName,
          userId,
          sessionId,
          filename: 'report.pdf',
        });
        expect(loaded?.fileData?.fileUri).toBe('gs://my-bucket/report.pdf');
        expect(loaded?.fileData?.mimeType).toBe('application/pdf');
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });
  });

  describe('path security', () => {
    it('rejects traversal attempts', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);
      const appName = 'test-app';
      const userId = 'test-user';
      const sessionId = 'test-session';

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
        expect((e as Error).message).toContain('escapes storage directory');
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });

    it('allows filenames that only start with two dots', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);
      const appName = 'test-app';
      const userId = 'test-user';
      const sessionId = 'test-session';

      try {
        for (const filename of ['..notes.txt', '..drafts/report.txt']) {
          await service.saveArtifact({
            appName,
            userId,
            sessionId,
            filename,
            artifact: {text: filename},
          });
          const loaded = await service.loadArtifact({
            appName,
            userId,
            sessionId,
            filename,
          });
          expect(loaded?.text).toBe(filename);
        }

        const keys = await service.listArtifactKeys({
          appName,
          userId,
          sessionId,
        });
        expect(keys.sort()).toEqual(['..drafts/report.txt', '..notes.txt']);
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });

    const ROOT = '/tmp/adk-test-root';

    describe('assertSafeSegment - valid inputs', () => {
      it('allows a plain alphanumeric userId', () => {
        expect(() => getUserRoot(ROOT, 'alice')).not.toThrow();
      });
      it('allows a UUID as userId', () => {
        expect(() =>
          getUserRoot(ROOT, '550e8400-e29b-41d4-a716-446655440000'),
        ).not.toThrow();
      });
      it('allows an email-style userId', () => {
        expect(() => getUserRoot(ROOT, 'user.name@org')).not.toThrow();
      });
      it('allows a plain alphanumeric sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(`${ROOT}/users/alice`, 'session-abc123'),
        ).not.toThrow();
      });
    });

    describe('assertSafeSegment - userId attacks', () => {
      it('blocks dot-dot-slash traversal in userId', () => {
        expect(() => getUserRoot(ROOT, '../../etc')).toThrow('Invalid userId');
      });
      it('blocks forward slash in userId', () => {
        expect(() => getUserRoot(ROOT, 'a/b')).toThrow('Invalid userId');
      });
      it('blocks percent-encoded slash in userId', () => {
        expect(() => getUserRoot(ROOT, '..%2F..%2Fetc')).toThrow(
          'Invalid userId',
        );
      });
      it('blocks null byte in userId', () => {
        expect(() => getUserRoot(ROOT, 'alice\x00')).toThrow('Invalid userId');
      });
      it('blocks empty string as userId', () => {
        expect(() => getUserRoot(ROOT, '')).toThrow('Invalid userId');
      });
    });

    describe('assertSafeSegment - sessionId attacks', () => {
      const base = `${ROOT}/users/alice`;
      it('blocks dot-dot-slash traversal in sessionId', () => {
        expect(() => getSessionArtifactsDir(base, '../../../secret')).toThrow(
          'Invalid sessionId',
        );
      });
      it('blocks forward slash in sessionId', () => {
        expect(() => getSessionArtifactsDir(base, 'sess/../../etc')).toThrow(
          'Invalid sessionId',
        );
      });
      it('blocks percent-encoded slash in sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(base, '..%2F..%2F..%2Fsecret'),
        ).toThrow('Invalid sessionId');
      });
      it('blocks empty string as sessionId', () => {
        expect(() => getSessionArtifactsDir(base, '')).toThrow(
          'Invalid sessionId',
        );
      });
    });

    describe('assertInsideRoot - defence-in-depth', () => {
      it('throws when resolved path escapes root', () => {
        expect(() =>
          assertInsideRoot('/tmp/root/../outside', '/tmp/root', 'test'),
        ).toThrow('escapes storage root');
      });
      it('allows a path equal to root', () => {
        expect(() =>
          assertInsideRoot('/tmp/root', '/tmp/root', 'test'),
        ).not.toThrow();
      });
      it('allows a path nested inside root', () => {
        expect(() =>
          assertInsideRoot('/tmp/root/users/alice', '/tmp/root', 'test'),
        ).not.toThrow();
      });
    });
  });
});
