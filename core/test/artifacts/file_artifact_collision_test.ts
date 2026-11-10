/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {fileURLToPath} from 'url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {FileArtifactService} from '../../src/artifacts/file_artifact_service.js';

describe('FileArtifactService payload and metadata filenames', () => {
  const key = {appName: 'app', userId: 'user', sessionId: 'session'};
  let root: string;
  let service: FileArtifactService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-payload-collision-'));
    service = new FileArtifactService(root);
  });

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true});
  });

  for (const filename of ['metadata.json', 'note.json']) {
    for (const restart of [false, true]) {
      it(`round-trips ${filename}${restart ? ' after a restart' : ''}`, async () => {
        const version = await service.saveArtifact({
          ...key,
          filename,
          artifact: {text: 'hello'},
        });
        expect(version).toBe(0);
        const reader = restart ? new FileArtifactService(root) : service;
        expect(await reader.loadArtifact({...key, filename, version})).toEqual({
          text: 'hello',
        });
      });
    }
  }

  it.each(['Metadata.JSON', 'nested/metadata.json', 'user:metadata.json'])(
    'keeps the payload and canonical URI for %s after a restart',
    async (filename) => {
      const version = await service.saveArtifact({
        ...key,
        filename,
        artifact: {text: 'hello'},
      });
      const reader = new FileArtifactService(root);
      expect(await reader.loadArtifact({...key, filename, version})).toEqual({
        text: 'hello',
      });
      const metadata = await reader.getArtifactVersion({
        ...key,
        filename,
        version,
      });
      expect(
        await fs.readFile(fileURLToPath(metadata!.canonicalUri!), 'utf8'),
      ).toBe('hello');
      expect(await reader.listArtifactKeys(key)).toEqual([filename]);
    },
  );

  it('keeps text, binary and pointer revisions with their own metadata', async () => {
    const filename = 'metadata.json';
    const artifactKey = {...key, filename};
    const bytes = Buffer.from('{"answer":42}');
    const artifacts = [
      {text: 'hello'},
      {
        inlineData: {
          data: bytes.toString('base64'),
          mimeType: 'application/json',
        },
      },
      {
        fileData: {
          fileUri: 'https://example.invalid/report.json',
          mimeType: 'application/json',
        },
      },
    ];
    for (const [version, artifact] of artifacts.entries()) {
      expect(
        await service.saveArtifact({
          ...artifactKey,
          artifact,
          customMetadata: {revision: version},
        }),
      ).toBe(version);
    }

    const reader = new FileArtifactService(root);
    expect(await reader.listVersions(artifactKey)).toEqual([0, 1, 2]);
    const versions = await reader.listArtifactVersions(artifactKey);
    expect(versions.map((version) => version.customMetadata)).toEqual([
      {revision: 0},
      {revision: 1},
      {revision: 2},
    ]);
    for (const [version, artifact] of artifacts.entries()) {
      expect(await reader.loadArtifact({...artifactKey, version})).toEqual(
        artifact,
      );
    }
    expect(await reader.loadArtifact(artifactKey)).toEqual(artifacts[2]);
    expect(await fs.readFile(fileURLToPath(versions[0].canonicalUri!))).toEqual(
      Buffer.from('hello'),
    );
    expect(await fs.readFile(fileURLToPath(versions[1].canonicalUri!))).toEqual(
      bytes,
    );
    const versionDir = path.join(
      root,
      'users',
      key.userId,
      'sessions',
      key.sessionId,
      'artifacts',
      filename,
      'versions',
      '2',
    );
    expect(await fs.readdir(versionDir)).toEqual(['metadata.json']);
  });

  it('reads relocated collision payloads when the original URI no longer exists', async () => {
    const original = path.join(root, 'original');
    const moved = path.join(root, 'moved');
    const writer = new FileArtifactService(original);
    const artifactKey = {...key, filename: 'metadata.json'};
    await writer.saveArtifact({...artifactKey, artifact: {text: 'hello'}});
    const metadata = await writer.getArtifactVersion(artifactKey);
    await fs.rename(original, moved);

    await expect(
      fs.access(fileURLToPath(metadata!.canonicalUri!)),
    ).rejects.toThrow();
    expect(
      await new FileArtifactService(moved).loadArtifact(artifactKey),
    ).toEqual({
      text: 'hello',
    });
  });

  it.for(['note.json', 'METADATA.JSON'])(
    'reads the original %s layout without a canonical URI',
    async (filename, ctx) => {
      // A valid legacy uppercase payload exists only on case-sensitive storage.
      if (filename === 'METADATA.JSON') {
        await fs.writeFile(path.join(root, 'case-check'), 'probe');
        const aliases = await fs.access(path.join(root, 'CASE-CHECK')).then(
          () => true,
          () => false,
        );
        if (aliases) ctx.skip();
      }
      const versionDir = path.join(
        root,
        'users',
        key.userId,
        'sessions',
        key.sessionId,
        'artifacts',
        filename,
        'versions',
        '0',
      );
      await fs.mkdir(versionDir, {recursive: true});
      await fs.writeFile(path.join(versionDir, filename), 'legacy hello');
      const originalMetadata = JSON.stringify({fileName: filename, version: 0});
      await fs.writeFile(
        path.join(versionDir, 'metadata.json'),
        originalMetadata,
      );

      expect(
        await service.loadArtifact({...key, filename, version: 0}),
      ).toEqual({
        text: 'legacy hello',
      });
      expect(
        await service.saveArtifact({
          ...key,
          filename,
          artifact: {text: 'new hello'},
        }),
      ).toBe(1);
      expect(await service.listVersions({...key, filename})).toEqual([0, 1]);
      const reader = new FileArtifactService(root);
      expect(await reader.loadArtifact({...key, filename})).toEqual({
        text: 'new hello',
      });
      expect(await reader.loadArtifact({...key, filename, version: 0})).toEqual(
        {
          text: 'legacy hello',
        },
      );
      expect(
        await fs.readFile(path.join(versionDir, 'metadata.json'), 'utf8'),
      ).toBe(originalMetadata);
    },
  );
});
