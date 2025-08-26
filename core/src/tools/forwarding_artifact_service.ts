/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {InvocationContext} from '../agents/invocation_context.js';
import {BaseArtifactService, DeleteArtifactRequest, ListArtifactKeysRequest, ListVersionsRequest, LoadArtifactRequest, SaveArtifactRequest,} from '../artifacts/base_artifact_service.js';

import {ToolContext} from './tool_context.js';

/**
 * Artifact service that forwards to the parent tool context.
 */
export class ForwardingArtifactService implements BaseArtifactService {
  private readonly invocationContext: InvocationContext;

  constructor(private readonly toolContext: ToolContext) {
    this.invocationContext = toolContext.invocationContext;
  }

  // TODO - b/425992518: Remove unnecessary parameters. We should rethink the
  // abstraction layer to make it more clear.
  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    return this.toolContext.saveArtifact(request.filename, request.artifact);
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part|undefined> {
    return this.toolContext.loadArtifact(request.filename, request.version);
  }

  async listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    return this.toolContext.listArtifacts();
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    if (!this.toolContext.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.toolContext.invocationContext.artifactService.deleteArtifact(
        request);
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    if (!this.toolContext.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.toolContext.invocationContext.artifactService.listVersions(
        request);
  }
}
