/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {FileArtifactService} from '../../src/artifacts/file_artifact_service.js';

describe('supplemental artifact layout quality', () => {
  const key = {appName: 'app', userId: 'user', sessionId: 'session'};
  const names = [
    'metadata.json',
    'content',
    'metadata.json/content',
    'metadata.json/content/nested.txt',
    'content/metadata.json',
    'folder/metadata.json',
    'folder/content',
  ];
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-layout-quality-'));
  });

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true});
  });

  for (const reversed of [false, true]) {
    it(`keeps legal artifact names separate in ${reversed ? 'child-first' : 'parent-first'} order`, async () => {
      const order = reversed ? [...names].reverse() : names;
      const service = new FileArtifactService(root);
      for (const filename of order) {
        for (const version of [0, 1]) {
          expect(
            await service.saveArtifact({
              ...key,
              filename,
              artifact: {text: `${filename}:revision-${version}`},
            }),
          ).toBe(version);
        }
      }

      const reader = new FileArtifactService(root);
      expect(await reader.listArtifactKeys(key)).toEqual([...names].sort());
      const uris = new Set<string>();
      for (const filename of names) {
        const artifactKey = {...key, filename};
        expect(await reader.listVersions(artifactKey)).toEqual([0, 1]);
        expect(await reader.loadArtifact(artifactKey)).toEqual({
          text: `${filename}:revision-1`,
        });
        for (const version of [0, 1]) {
          const text = `${filename}:revision-${version}`;
          expect(await reader.loadArtifact({...artifactKey, version})).toEqual({
            text,
          });
          const metadata = await reader.getArtifactVersion({
            ...artifactKey,
            version,
          });
          expect(metadata?.canonicalUri).toBeDefined();
          uris.add(metadata!.canonicalUri!);
          expect(
            await fs.readFile(fileURLToPath(metadata!.canonicalUri!), 'utf8'),
          ).toBe(text);
        }
      }
      expect(uris.size).toBe(names.length * 2);
    });
  }

  for (const recordedContentName of [false, true]) {
    it(`prefers an existing canonical URI ${recordedContentName ? 'with' : 'without'} a recorded payload name`, async () => {
      const filename = recordedContentName ? 'metadata.json' : 'legacy.txt';
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
      const fallback = path.join(
        versionDir,
        recordedContentName ? 'content' : filename,
      );
      await fs.writeFile(fallback, 'fallback body');
      const canonical = path.join(root, 'canonical-body.txt');
      await fs.writeFile(canonical, 'canonical body');
      const metadataPath = path.join(versionDir, 'metadata.json');
      const originalMetadata = JSON.stringify({
        fileName: filename,
        version: 0,
        canonicalUri: pathToFileURL(canonical).toString(),
        ...(recordedContentName ? {contentFileName: 'content'} : {}),
      });
      await fs.writeFile(metadataPath, originalMetadata);

      const reader = new FileArtifactService(root);
      expect(await reader.loadArtifact({...key, filename, version: 0})).toEqual(
        {
          text: 'canonical body',
        },
      );
      expect(await fs.readFile(fallback, 'utf8')).toBe('fallback body');
      expect(await fs.readFile(canonical, 'utf8')).toBe('canonical body');
      expect(await fs.readFile(metadataPath, 'utf8')).toBe(originalMetadata);
    });
  }
});
