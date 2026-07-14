/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createPartFromText, Part} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {logger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

function isModelAccessibleUri(uri: string): boolean {
  return /^(gs|https?):\/\//i.test(uri);
}

async function buildFileReferencePart(
  invocationContext: InvocationContext,
  filename: string,
  version: number,
  mimeType: string | undefined,
  displayName: string,
): Promise<Part | undefined> {
  const artifactService = invocationContext.artifactService!;
  try {
    const artifactVersion = await artifactService.getArtifactVersion({
      filename,
      version,
    });
    if (
      !artifactVersion?.canonicalUri ||
      !isModelAccessibleUri(artifactVersion.canonicalUri)
    ) {
      return undefined;
    }
    return {
      fileData: {
        fileUri: artifactVersion.canonicalUri,
        mimeType: mimeType || artifactVersion.mimeType,
        displayName,
      },
    };
  } catch (exc) {
    logger.warn(`Failed to resolve artifact version for ${filename}: ${exc}`);
    return undefined;
  }
}

export interface SaveFilesAsArtifactsPluginOptions {
  name?: string;
  attachFileReference?: boolean;
}

export class SaveFilesAsArtifactsPlugin extends BasePlugin {
  private readonly attachFileReference: boolean;

  constructor(options: SaveFilesAsArtifactsPluginOptions = {}) {
    super(options.name || 'save_files_as_artifacts_plugin');
    this.attachFileReference = options.attachFileReference ?? true;
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    if (!invocationContext.artifactService) {
      logger.warn(
        'Artifact service is not set. SaveFilesAsArtifactsPlugin will not be enabled.',
      );
      return undefined;
    }

    if (!userMessage.parts || userMessage.parts.length === 0) {
      return undefined;
    }

    const newParts: Part[] = [];
    const pendingDelta: Record<string, number> = {};

    for (let i = 0; i < userMessage.parts.length; i++) {
      const part = userMessage.parts[i];
      if (!part.inlineData) {
        newParts.push(part);
        continue;
      }

      try {
        const inlineData = part.inlineData;
        let filename = inlineData.displayName;
        if (!filename) {
          filename = `artifact_${invocationContext.invocationId}_${i}`;
          logger.info(
            `No displayName found, using generated filename: ${filename}`,
          );
        }

        const version = await invocationContext.artifactService.saveArtifact({
          filename,
          artifact: {...part},
        });

        newParts.push(createPartFromText(`[Uploaded Artifact: "${filename}"]`));

        if (this.attachFileReference) {
          const filePart = await buildFileReferencePart(
            invocationContext,
            filename,
            version,
            inlineData.mimeType,
            filename,
          );
          if (filePart) {
            newParts.push(filePart);
          }
        }
        pendingDelta[filename] = version;
        logger.info(`Successfully saved artifact: ${filename}`);
      } catch (e) {
        logger.error(`Failed to save artifact for part ${i}: ${e}`);
        newParts.push(part);
      }
    }

    if (Object.keys(pendingDelta).length > 0) {
      const state = invocationContext.session.state;
      const key = `${this.name}:pending_delta`;
      state[key] = Object.assign(
        (state[key] as Record<string, number>) || {},
        pendingDelta,
      );
      return {
        role: userMessage.role,
        parts: newParts,
      };
    }

    return undefined;
  }

  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    const key = `${this.name}:pending_delta`;
    const pendingDelta = callbackContext.state.get<Record<string, number>>(key);
    if (pendingDelta && Object.keys(pendingDelta).length > 0) {
      Object.assign(callbackContext.actions.artifactDelta, pendingDelta);
      callbackContext.state.set(key, {});
    }
    return undefined;
  }
}
