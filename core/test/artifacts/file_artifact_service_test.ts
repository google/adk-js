/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileArtifactService} from '@google/adk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {
  assertInsideRoot,
  getSessionArtifactsDir,
  getUserRoot,
} from '../../src/artifacts/file_artifact_service.js';
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

    it.runIf(process.platform === 'win32')(
      'stores names with characters Windows rejects without percent-encoding collisions',
      async () => {
        rootDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'adk-artifacts-test-'),
        );
        const service = new FileArtifactService(rootDir);
        const request = {appName: 'app', userId: 'user', sessionId: 'session'};
        const names = [
          'report_2026-10-30T11:22:32.txt',
          'a?b<c>d|e*f".txt',
          'foo:bar.txt',
          'foo%3Abar.txt',
          'a?b.txt',
          'a%3Fb.txt',
        ];

        try {
          for (const filename of names) {
            const version = await service.saveArtifact({
              ...request,
              filename,
              artifact: {text: filename},
            });
            expect(version).toBe(0);
            const loaded = await service.loadArtifact({...request, filename});
            expect(loaded?.text).toBe(filename);
          }
          expect(await service.listArtifactKeys(request)).toEqual(
            [...names].sort(),
          );
        } finally {
          await fs.rm(rootDir, {recursive: true, force: true});
        }
      },
    );

    it.runIf(process.platform === 'win32')(
      'rejects Windows absolute and drive-qualified filenames',
      async () => {
        rootDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'adk-artifacts-test-'),
        );
        const service = new FileArtifactService(rootDir);
        const request = {appName: 'app', userId: 'user', sessionId: 'session'};

        try {
          for (const filename of ['C:\\x', 'C:x', 'user:C:\\x', 'user:C:x']) {
            await expect(
              service.saveArtifact({
                ...request,
                filename,
                artifact: {text: '.'},
              }),
            ).rejects.toThrow(/Absolute artifact filename .* is not permitted/);
          }
        } finally {
          await fs.rm(rootDir, {recursive: true, force: true});
        }
      },
    );

    it('rejects drive-qualified paths and escapes % under win32 mode', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);
      const request = {appName: 'app', userId: 'user', sessionId: 'session'};
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {value: 'win32'});

      try {
        for (const filename of ['C:\\x', 'C:x', 'user:C:\\x', 'user:C:x']) {
          await expect(
            service.saveArtifact({
              ...request,
              filename,
              artifact: {text: '.'},
            }),
          ).rejects.toThrow(/Absolute artifact filename .* is not permitted/);
        }

        expect(
          await service.saveArtifact({
            ...request,
            filename: 'foo:bar.txt',
            artifact: {text: 'colon'},
          }),
        ).toBe(0);
        expect(
          await service.saveArtifact({
            ...request,
            filename: 'foo%3Abar.txt',
            artifact: {text: 'percent'},
          }),
        ).toBe(0);

        const loadedColon = await service.loadArtifact({
          ...request,
          filename: 'foo:bar.txt',
        });
        const loadedPercent = await service.loadArtifact({
          ...request,
          filename: 'foo%3Abar.txt',
        });
        expect(loadedColon?.text).toBe('colon');
        expect(loadedPercent?.text).toBe('percent');
      } finally {
        Object.defineProperty(process, 'platform', {value: originalPlatform});
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });

    it('does not collide across save, load, list, or delete for names differing only in case', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);
      const request = {appName: 'app', userId: 'user', sessionId: 'session'};

      try {
        await service.saveArtifact({
          ...request,
          filename: 'Report.txt',
          artifact: {text: 'upper'},
        });
        const caseInsensitive = await fs
          .access(path.join(rootDir, 'USERS'))
          .then(() => true)
          .catch(() => false);

        const saveLower = service.saveArtifact({
          ...request,
          filename: 'report.txt',
          artifact: {text: 'lower'},
        });
        if (caseInsensitive) {
          await expect(saveLower).rejects.toThrow(/same location/);
          expect(
            await service.loadArtifact({...request, filename: 'report.txt'}),
          ).toBeUndefined();
          expect(
            await service.listVersions({...request, filename: 'report.txt'}),
          ).toEqual([]);
          expect(
            await service.listArtifactVersions({
              ...request,
              filename: 'report.txt',
            }),
          ).toEqual([]);
          expect(
            await service.getArtifactVersion({
              ...request,
              filename: 'report.txt',
            }),
          ).toBeUndefined();

          await service.deleteArtifact({...request, filename: 'report.txt'});
        } else {
          expect(await saveLower).toBe(0);
        }
        const loaded = await service.loadArtifact({
          ...request,
          filename: 'Report.txt',
        });
        expect(loaded?.text).toBe('upper');
        expect(
          await service.listVersions({...request, filename: 'Report.txt'}),
        ).toEqual([0]);
        expect(
          await service.listArtifactVersions({
            ...request,
            filename: 'Report.txt',
          }),
        ).toHaveLength(1);
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
