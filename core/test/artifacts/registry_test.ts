/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FileArtifactService,
  GcsArtifactService,
  InMemoryArtifactService,
  getArtifactServiceFromUri,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('getArtifactServiceFromUri', () => {
  it('returns InMemoryArtifactService for memory uri', () => {
    const service = getArtifactServiceFromUri('memory://');
    expect(service).toBeInstanceOf(InMemoryArtifactService);
  });

  it('returns GcsArtifactService for gs uri', () => {
    const service = getArtifactServiceFromUri('gs://my-bucket');
    expect(service).toBeInstanceOf(GcsArtifactService);
    expect((service as unknown as {bucket: {name: string}}).bucket.name).toBe(
      'my-bucket',
    );
  });

  it('returns FileArtifactService for file uri', () => {
    const service = getArtifactServiceFromUri('file:///tmp/artifacts');
    expect(service).toBeInstanceOf(FileArtifactService);
  });

  it('throws error for unsupported uri', () => {
    expect(() => getArtifactServiceFromUri('unsupported://uri')).toThrow(
      'Unsupported artifact service URI: unsupported://uri',
    );
  });
});
