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

    const artifact = await service.loadArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'nested/report.txt',
    });

    expect(artifact?.text).toBe('artifact-a');
  });
});
