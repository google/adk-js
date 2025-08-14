/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {InvocationContext} from '../agents/invocation_context.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';

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
  async saveArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      artifact: Part,
      ): Promise<number> {
    return this.toolContext.saveArtifact(filename, artifact);
  }

  async loadArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      version?: number,
      ): Promise<Part|undefined> {
    return this.toolContext.loadArtifact(filename, version);
  }

  async listArtifactKeys(
      appName: string,
      userId: string,
      sessionId: string,
      ): Promise<string[]> {
    return this.toolContext.listArtifacts();
  }

  async deleteArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      ): Promise<void> {
    if (!this.toolContext.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.toolContext.invocationContext.artifactService.deleteArtifact(
        this.invocationContext.appName,
        this.invocationContext.userId,
        this.invocationContext.session.id,
        filename,
    );
  }

  async listVersions(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      ): Promise<number[]> {
    if (!this.toolContext.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.toolContext.invocationContext.artifactService.listVersions(
        this.invocationContext.appName,
        this.invocationContext.userId,
        this.invocationContext.session.id,
        filename,
    );
  }
}
