/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {getLogger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

const logger = getLogger();

const MODEL_ACCESSIBLE_URI_SCHEMES = new Set(['gs', 'https', 'http']);

/**
 * Maximum file size for inlineData (20MB as per Gemini API documentation).
 * https://ai.google.dev/gemini-api/docs/files
 */
const MAX_INLINE_DATA_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Configuration options for {@link SaveFilesAsArtifactsPlugin}.
 */
export interface SaveFilesAsArtifactsPluginOptions {
  /**
   * The name of the plugin instance.
   * @defaultValue 'save_files_as_artifacts_plugin'
   */
  name?: string;

  /**
   * Whether to attach a file reference to the user message. If false,
   * only saves the files as artifacts without adding a file reference,
   * and the files will not be directly accessible to the model.
   * @defaultValue true
   */
  attachFileReference?: boolean;
}

/**
 * A plugin that saves files embedded in user messages as artifacts.
 *
 * This is useful to allow users to upload files in the chat experience and have
 * those files available to the agent within the current session.
 *
 * We use `inlineData.displayName` to determine the file name. By default, artifacts are
 * session-scoped. For cross-session persistence, prefix the filename with "user:".
 * Artifacts with the same name will be overwritten. A placeholder with the artifact name
 * will be put in place of the embedded file in the user message so the model knows where
 * to find the file. You may want to add `LoadArtifactsTool` to the agent, or load the
 * artifacts in your own tool to use the files.
 */
export class SaveFilesAsArtifactsPlugin extends BasePlugin {
  private readonly attachFileReference: boolean;

  /**
   * Initializes the SaveFilesAsArtifactsPlugin.
   *
   * @param nameOrOptions The plugin name or configuration options.
   */
  constructor(nameOrOptions?: string | SaveFilesAsArtifactsPluginOptions) {
    if (typeof nameOrOptions === 'string') {
      super(nameOrOptions);
      this.attachFileReference = true;
    } else {
      super(nameOrOptions?.name ?? 'save_files_as_artifacts_plugin');
      this.attachFileReference = nameOrOptions?.attachFileReference ?? true;
    }
  }

  /**
   * Processes the user message, validates file size, and saves any attached
   * files with inline data as session artifacts.
   *
   * @param params.invocationContext The context for the entire invocation.
   * @param params.userMessage The message content input by user.
   * @returns Modified content if artifacts were processed, or undefined.
   */
  override async onUserMessageCallback(params: {
    userMessage: Content;
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const {userMessage, invocationContext} = params;
    if (!invocationContext.artifactService) {
      logger.warn(
        'Artifact service is not set. SaveFilesAsArtifactsPlugin will not be enabled.',
      );
      return userMessage;
    }

    if (!userMessage.parts || userMessage.parts.length === 0) {
      return undefined;
    }

    const newParts: Part[] = [];
    const pendingDelta: Record<string, number> = {};
    let modified = false;

    for (let i = 0; i < userMessage.parts.length; i++) {
      const part = userMessage.parts[i];
      if (!part.inlineData) {
        newParts.push(part);
        continue;
      }

      try {
        const inlineData = part.inlineData;
        const fileSize = getInlineDataSizeBytes(inlineData.data);

        let fileName = (inlineData as {displayName?: string}).displayName;
        if (!fileName) {
          fileName = `artifact_${invocationContext.invocationId}_${i}`;
          logger.info(
            `No display_name found, using generated filename: ${fileName}`,
          );
        }

        const displayName = fileName;

        // Check if file exceeds inline_data limit (20MB)
        if (fileSize > MAX_INLINE_DATA_SIZE_BYTES) {
          const fileSizeMb = fileSize / (1024 * 1024);
          const limitMb = MAX_INLINE_DATA_SIZE_BYTES / (1024 * 1024);
          const errorMessage =
            `File ${displayName} (${fileSizeMb.toFixed(2)} MB) exceeds the ` +
            `maximum supported size of ${limitMb.toFixed(0)}MB. Please upload a smaller file.`;
          logger.warn(errorMessage);
          newParts.push({text: `[Upload Error: ${errorMessage}]`});
          modified = true;
          continue;
        }

        // For files <= 20MB, save artifact (create a shallow copy to prevent mutation)
        const version = await invocationContext.artifactService.saveArtifact({
          filename: fileName,
          artifact: {...part},
        });

        newParts.push({text: `[Uploaded Artifact: "${displayName}"]`});

        if (this.attachFileReference) {
          const filePart = await this.buildFileReferencePart(
            invocationContext,
            fileName,
            version,
            inlineData.mimeType,
            displayName,
          );
          if (filePart) {
            newParts.push(filePart);
          }
        }

        pendingDelta[fileName] = version;
        modified = true;
        logger.info(`Successfully saved artifact: ${fileName}`);
      } catch (error) {
        logger.error(`Failed to save artifact for part ${i}:`, error);
        // Keep the original part if saving fails
        newParts.push(part);
      }
    }

    if (modified) {
      // Store pending delta in state until it can be written to event actions.
      const state = invocationContext.session.state;
      const deltaKey = `${this.name}:pending_delta`;
      const existingDelta =
        (state[deltaKey] as Record<string, number> | undefined) ?? {};
      state[deltaKey] = {...existingDelta, ...pendingDelta};
      return {
        role: userMessage.role,
        parts: newParts,
      };
    }

    return undefined;
  }

  /**
   * Writes the pending delta to event actions before agent execution.
   *
   * @param params.agent The agent that is about to run.
   * @param params.callbackContext The context for the agent invocation.
   * @returns undefined
   */
  override async beforeAgentCallback(params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    const {callbackContext} = params;
    const deltaKey = `${this.name}:pending_delta`;
    const pendingDelta =
      callbackContext.state.get<Record<string, number>>(deltaKey);
    if (pendingDelta && Object.keys(pendingDelta).length > 0) {
      try {
        Object.assign(callbackContext.actions.artifactDelta, pendingDelta);
      } catch (e) {
        logger.warn(`Incompatible pending_delta type: ${e}`);
      } finally {
        callbackContext.state.set(deltaKey, {});
      }
    }
    return undefined;
  }

  /**
   * Constructs a file reference part if the artifact URI is model-accessible.
   */
  private async buildFileReferencePart(
    invocationContext: InvocationContext,
    filename: string,
    version: number,
    mimeType: string | undefined,
    displayName: string,
  ): Promise<Part | undefined> {
    const artifactService = invocationContext.artifactService;
    if (!artifactService) {
      return undefined;
    }

    let artifactVersion;
    try {
      artifactVersion = await artifactService.getArtifactVersion({
        filename,
        version,
      });
    } catch (exc) {
      logger.warn(`Failed to resolve artifact version for ${filename}: ${exc}`);
      return undefined;
    }

    if (
      !artifactVersion ||
      !artifactVersion.canonicalUri ||
      !isModelAccessibleUri(artifactVersion.canonicalUri)
    ) {
      return undefined;
    }

    return {
      fileData: {
        fileUri: artifactVersion.canonicalUri,
        mimeType: mimeType || artifactVersion.mimeType || '',
        displayName,
      },
    };
  }
}

function getInlineDataSizeBytes(data?: string | Uint8Array): number {
  if (!data) {
    return 0;
  }
  if (typeof data === 'string') {
    if (typeof Buffer !== 'undefined') {
      return Buffer.byteLength(data);
    }
    return new TextEncoder().encode(data).length;
  }
  if (data instanceof Uint8Array) {
    return data.byteLength;
  }
  return 0;
}

function isModelAccessibleUri(uri: string): boolean {
  try {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
    if (!match) {
      return false;
    }
    return MODEL_ACCESSIBLE_URI_SCHEMES.has(match[1].toLowerCase());
  } catch {
    return false;
  }
}
