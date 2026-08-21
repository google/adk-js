/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileArtifactService, InMemoryArtifactService} from '@google/adk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const SCOPE = {
  appName: 'test_app',
  userId: 'test_user',
  sessionId: 'test_session',
};

describe('concurrent saveArtifact (characterization for PR #770 review F1)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-concurrent-save-'));
  });

  afterEach(async () => {
    await fs.rm(rootDir, {recursive: true, force: true});
  });

  it('FileArtifactService: two concurrent saves of the same filename get distinct versions', async () => {
    // saveArtifact serializes the version read-modify-write per artifact
    // path, so two in-flight saves of the same filename resolve distinct
    // versions and both payloads survive.
    const service = new FileArtifactService(rootDir);
    const versions = await Promise.all([
      service.saveArtifact({
        ...SCOPE,
        filename: 'report.txt',
        artifact: {text: 'payload-A'},
      }),
      service.saveArtifact({
        ...SCOPE,
        filename: 'report.txt',
        artifact: {text: 'payload-B'},
      }),
    ]);

    expect(versions.sort()).toEqual([0, 1]);
    expect(
      await service.listVersions({...SCOPE, filename: 'report.txt'}),
    ).toEqual([0, 1]);
    const payloads = await Promise.all(
      [0, 1].map(async (version) => {
        const part = await service.loadArtifact({
          ...SCOPE,
          filename: 'report.txt',
          version,
        });
        return (
          part?.text ??
          Buffer.from(part?.inlineData?.data ?? '', 'base64').toString('utf-8')
        );
      }),
    );
    expect(payloads.sort()).toEqual(['payload-A', 'payload-B']);
  });

  it('FileArtifactService: concurrent saves of DIFFERENT filenames stay concurrent and correct', async () => {
    const service = new FileArtifactService(rootDir);
    const versions = await Promise.all([
      service.saveArtifact({
        ...SCOPE,
        filename: 'left.txt',
        artifact: {text: 'left'},
      }),
      service.saveArtifact({
        ...SCOPE,
        filename: 'right.txt',
        artifact: {text: 'right'},
      }),
    ]);
    expect(versions).toEqual([0, 0]);
  });

  it('FileArtifactService: sequential saves version correctly (control)', async () => {
    const service = new FileArtifactService(rootDir);
    const first = await service.saveArtifact({
      ...SCOPE,
      filename: 'report.txt',
      artifact: {text: 'payload-A'},
    });
    const second = await service.saveArtifact({
      ...SCOPE,
      filename: 'report.txt',
      artifact: {text: 'payload-B'},
    });
    expect([first, second]).toEqual([0, 1]);
  });

  it('InMemoryArtifactService: concurrent saves do not collide (version computed synchronously)', async () => {
    const service = new InMemoryArtifactService();
    const versions = await Promise.all([
      service.saveArtifact({
        ...SCOPE,
        filename: 'report.txt',
        artifact: {text: 'payload-A'},
      }),
      service.saveArtifact({
        ...SCOPE,
        filename: 'report.txt',
        artifact: {text: 'payload-B'},
      }),
    ]);
    expect(versions.sort()).toEqual([0, 1]);
  });
});
