/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
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
    private readonly appName: string,
    private readonly userId: string,
    private readonly sessionId: string,
  ) {}

  async saveArtifact(request: SessionSaveArtifactRequest): Promise<number> {
    return this.delegate.saveArtifact({
      appName: this.appName,
      userId: this.userId,
      sessionId: this.sessionId,
      ...request,
    });
  }

  async loadArtifact(
    request: SessionLoadArtifactRequest,
  ): Promise<Part | undefined> {
    return this.delegate.loadArtifact({
      appName: this.appName,
      userId: this.userId,
      sessionId: this.sessionId,
      ...request,
    });
  }

  async listArtifactKeys(): Promise<string[]> {
    return this.delegate.listArtifactKeys({
      appName: this.appName,
      userId: this.userId,
      sessionId: this.sessionId,
    });
  }

  async deleteArtifact(filename: string): Promise<void> {
    return this.delegate.deleteArtifact({
      appName: this.appName,
      userId: this.userId,
      sessionId: this.sessionId,
      filename,
    });
  }

  async listVersions(filename: string): Promise<number[]> {
    return this.delegate.listVersions({
      appName: this.appName,
      userId: this.userId,
      sessionId: this.sessionId,
      filename,
    });
  }

  async listArtifactVersions(filename: string): Promise<ArtifactVersion[]> {
    return this.delegate.listArtifactVersions({
      appName: this.appName,
      userId: this.userId,
      sessionId: this.sessionId,
      filename,
    });
  }

  async getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    return this.delegate.getArtifactVersion({
      appName: this.appName,
      userId: this.userId,
      sessionId: this.sessionId,
      ...request,
    });
  }
}
