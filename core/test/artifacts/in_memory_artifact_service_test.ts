/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryArtifactService} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

describe('InMemoryArtifactService', () => {
  runArtifactServiceTests(
    async () => new InMemoryArtifactService(),
    async () => {},
  );

  it('keeps artifacts with ambiguous path components isolated', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'nested/report.txt',
      artifact: {text: 'artifact-a'},
    });
    await service.saveArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session/nested',
      filename: 'report.txt',
      artifact: {text: 'artifact-b'},
    });

    const artifactA = await service.loadArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'nested/report.txt',
    });
    const artifactB = await service.loadArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session/nested',
      filename: 'report.txt',
    });

    expect(artifactA?.text).toBe('artifact-a');
    expect(artifactB?.text).toBe('artifact-b');
  });

  it('keeps artifacts with ambiguous app and user components isolated', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app',
      userId: 'nested/user',
      sessionId: 'session',
      filename: 'report.txt',
      artifact: {text: 'artifact-a'},
    });
    await service.saveArtifact({
      appName: 'app/nested',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
      artifact: {text: 'artifact-b'},
    });

    const artifactA = await service.loadArtifact({
      appName: 'app',
      userId: 'nested/user',
      sessionId: 'session',
      filename: 'report.txt',
    });
    const artifactB = await service.loadArtifact({
      appName: 'app/nested',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
    });

    expect(artifactA?.text).toBe('artifact-a');
    expect(artifactB?.text).toBe('artifact-b');
  });

  describe('canonicalUri', () => {
    const key = {appName: 'app0', userId: 'user0', sessionId: '123'};

    async function saveVersions(
      service: InMemoryArtifactService,
      filename: string,
      count: number,
    ): Promise<void> {
      for (let i = 0; i < count; i++) {
        await service.saveArtifact({
          ...key,
          filename,
          artifact: {text: `v${i}`},
        });
      }
    }

    it('builds a session-scoped memory:// URI for each version', async () => {
      const service = new InMemoryArtifactService();
      await saveVersions(service, 'filename', 4);

      const versions = await service.listArtifactVersions({
        ...key,
        filename: 'filename',
      });

      expect(versions.map((v) => v.canonicalUri)).toEqual([
        'memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/0',
        'memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/1',
        'memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/2',
        'memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/3',
      ]);
    });

    it('omits the session segment for user-scoped artifacts', async () => {
      const service = new InMemoryArtifactService();
      await saveVersions(service, 'user:document.pdf', 4);

      const versions = await service.listArtifactVersions({
        ...key,
        filename: 'user:document.pdf',
      });

      expect(versions.map((v) => v.canonicalUri)).toEqual([
        'memory://apps/app0/users/user0/artifacts/user:document.pdf/versions/0',
        'memory://apps/app0/users/user0/artifacts/user:document.pdf/versions/1',
        'memory://apps/app0/users/user0/artifacts/user:document.pdf/versions/2',
        'memory://apps/app0/users/user0/artifacts/user:document.pdf/versions/3',
      ]);
    });

    it('returns the canonical URI from getArtifactVersion', async () => {
      const service = new InMemoryArtifactService();
      await saveVersions(service, 'filename', 3);

      const second = await service.getArtifactVersion({
        ...key,
        filename: 'filename',
        version: 1,
      });
      const latest = await service.getArtifactVersion({
        ...key,
        filename: 'filename',
      });

      expect(second?.canonicalUri).toBe(
        'memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/1',
      );
      expect(latest?.canonicalUri).toBe(
        'memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/2',
      );
    });

    it('interpolates path segments verbatim', async () => {
      const service = new InMemoryArtifactService();
      await saveVersions(service, 'nested/report.txt', 1);

      const version = await service.getArtifactVersion({
        ...key,
        filename: 'nested/report.txt',
      });

      expect(version?.canonicalUri).toBe(
        'memory://apps/app0/users/user0/sessions/123/artifacts/nested/report.txt/versions/0',
      );
    });

    it('sets a canonical URI for fileData artifacts', async () => {
      const service = new InMemoryArtifactService();
      await service.saveArtifact({
        ...key,
        filename: 'report.pdf',
        artifact: {
          fileData: {
            fileUri: 'gs://bucket/report.pdf',
            mimeType: 'application/pdf',
          },
        },
      });

      const version = await service.getArtifactVersion({
        ...key,
        filename: 'report.pdf',
      });

      expect(version?.canonicalUri).toBe(
        'memory://apps/app0/users/user0/sessions/123/artifacts/report.pdf/versions/0',
      );
      expect(version?.mimeType).toBe('application/pdf');
    });
  });

  it('does not leak a session named user into other sessions', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'user',
      filename: 'foo.txt',
      artifact: {text: 'session-scoped'},
    });

    const keys = await service.listArtifactKeys({
      appName: 'app',
      userId: 'user',
      sessionId: 'other',
    });

    expect(keys).toEqual([]);
  });
});
