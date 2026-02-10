/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseArtifactService} from './base_artifact_service.js';
import {GcsArtifactService} from './gcs_artifact_service.js';
import {
  InMemoryArtifactService,
  isInMemoryConnectionString,
} from './in_memory_artifact_service.js';

export function getArtifactServiceFromUri(uri: string): BaseArtifactService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemoryArtifactService();
  }

  if (uri.startsWith('gs://')) {
    const bucket = uri.split('://')[1];

    return new GcsArtifactService(bucket);
  }

  throw new Error(`Unsupported artifact service URI: ${uri}`);
}
