/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {SessionScope} from '../sessions/session_scope.js';
import {ArtifactVersion, BaseArtifactService} from './base_artifact_service.js';
import {
  SessionArtifactService,
  SessionLoadArtifactRequest,
  SessionSaveArtifactRequest,
} from './session_artifact_service.js';

/**
 * A wrapper that scopes a BaseArtifactService to a specific session.
 */
export class ScopedArtifactService implements SessionArtifactService {
  constructor(
    private readonly delegate: BaseArtifactService,
    private readonly scope: SessionScope,
  ) {}

  async saveArtifact(request: SessionSaveArtifactRequest): Promise<number> {
    return this.delegate.saveArtifact({
      scope: this.scope,
      ...request,
    });
  }

  async loadArtifact(
    request: SessionLoadArtifactRequest,
  ): Promise<Part | undefined> {
    return this.delegate.loadArtifact({
      scope: this.scope,
      ...request,
    });
  }

  async listArtifactKeys(): Promise<string[]> {
    return this.delegate.listArtifactKeys({
      scope: this.scope,
    });
  }

  async deleteArtifact(filename: string): Promise<void> {
    return this.delegate.deleteArtifact({
      scope: this.scope,
      filename,
    });
  }

  async listVersions(filename: string): Promise<number[]> {
    return this.delegate.listVersions({
      scope: this.scope,
      filename,
    });
  }

  async listArtifactVersions(filename: string): Promise<ArtifactVersion[]> {
    return this.delegate.listArtifactVersions({
      scope: this.scope,
      filename,
    });
  }

  async getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    return this.delegate.getArtifactVersion({
      scope: this.scope,
      ...request,
    });
  }
}
