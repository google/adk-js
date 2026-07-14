/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {ArtifactVersion} from '../artifacts/base_artifact_service.js';
import {
  SessionArtifactService,
  SessionLoadArtifactRequest,
  SessionSaveArtifactRequest,
} from '../artifacts/session_artifact_service.js';

import {Context} from '../agents/context.js';

/**
 * Artifact service that forwards to the parent tool context.
 */
export class ForwardingArtifactService implements SessionArtifactService {
  constructor(private readonly toolContext: Context) {}

  async saveArtifact(request: SessionSaveArtifactRequest): Promise<number> {
    return this.toolContext.saveArtifact(request.filename, request.artifact);
  }

  async loadArtifact(
    request: SessionLoadArtifactRequest,
  ): Promise<Part | undefined> {
    return this.toolContext.loadArtifact(request.filename, request.version);
  }

  async listArtifactKeys(): Promise<string[]> {
    return this.toolContext.listArtifacts();
  }

  private getArtifactService(): SessionArtifactService {
    const service = this.toolContext.invocationContext.artifactService;

    if (!service) {
      throw new Error('Artifact service is not initialized.');
    }
    return service;
  }

  async deleteArtifact(filename: string): Promise<void> {
    return this.getArtifactService().deleteArtifact(filename);
  }

  async listVersions(filename: string): Promise<number[]> {
    return this.getArtifactService().listVersions(filename);
  }

  async listArtifactVersions(filename: string): Promise<ArtifactVersion[]> {
    return this.getArtifactService().listArtifactVersions(filename);
  }

  async getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    return this.getArtifactService().getArtifactVersion(request);
  }
}
