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

  it('FileArtifactService: two concurrent saves of the same filename collide on one version', async () => {
    // saveArtifact computes nextVersion from a directory listing awaited
    // BEFORE the version directory is written, so two in-flight saves both
    // observe the empty listing and both resolve version 0. One payload
    // silently overwrites the other. A fix that serializes the per-file
    // read-modify-write should invert this assertion to [0, 1].
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

    expect(versions.sort()).toEqual([0, 0]);
    expect(
      await service.listVersions({...SCOPE, filename: 'report.txt'}),
    ).toEqual([0]);
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
