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
    // The GCS client is an optional peer loaded on first use, so the bucket
    // handle does not exist until then; the parsed name is what the registry
    // is responsible for and it is all that can be asserted synchronously.
    expect((service as unknown as {bucketName: string}).bucketName).toBe(
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
