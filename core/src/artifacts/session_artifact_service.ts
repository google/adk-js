/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {ArtifactVersion} from './base_artifact_service.js';

export interface SessionSaveArtifactRequest {
  filename: string;
  artifact: Part;
  customMetadata?: Record<string, unknown>;
}

export interface SessionLoadArtifactRequest {
  filename: string;
  version?: number;
}

export interface SessionArtifactService {
  saveArtifact(request: SessionSaveArtifactRequest): Promise<number>;
  loadArtifact(request: SessionLoadArtifactRequest): Promise<Part | undefined>;
  listArtifactKeys(): Promise<string[]>;
  deleteArtifact(filename: string): Promise<void>;
  listVersions(filename: string): Promise<number[]>;
  listArtifactVersions(filename: string): Promise<ArtifactVersion[]>;
  getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined>;
}
