/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Part, Type} from '@google/genai';

import {Context} from '../agents/context.js';
import {appendInstructions, LlmRequest} from '../models/llm_request.js';
import {getLogger} from '../utils/logger.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

const logger = getLogger();

const GEMINI_SUPPORTED_INLINE_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const GEMINI_SUPPORTED_INLINE_MIME_TYPES = new Set(['application/pdf']);
const TEXT_LIKE_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/xml',
]);

function normalizeMimeType(mimeType?: string): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  return mimeType.split(';')[0].trim();
}

function isInlineMimeTypeSupported(mimeType?: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return false;
  }
  return (
    GEMINI_SUPPORTED_INLINE_MIME_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    ) || GEMINI_SUPPORTED_INLINE_MIME_TYPES.has(normalized)
  );
}

function asSafePartForLlm(artifact: Part, artifactName: string): Part {
  const inlineData = artifact.inlineData;
  if (!inlineData) {
    return artifact;
  }

  if (isInlineMimeTypeSupported(inlineData.mimeType)) {
    return artifact;
  }

  const mimeType =
    normalizeMimeType(inlineData.mimeType) || 'application/octet-stream';
  const data = inlineData.data;
  if (!data) {
    return {
      text: `[Artifact: ${artifactName}, type: ${mimeType}. No inline data was provided.]`,
    };
  }

  const isTextLike =
    mimeType.startsWith('text/') || TEXT_LIKE_MIME_TYPES.has(mimeType);

  const decodedBuffer = Buffer.from(data, 'base64');
  if (isTextLike) {
    try {
      const decoded = decodedBuffer.toString('utf8');
      return {text: decoded};
    } catch {
      // Fallback
    }
  }

  const sizeKb = decodedBuffer.length / 1024;
  return {
    text: `[Binary artifact: ${artifactName}, type: ${mimeType}, size: ${sizeKb.toFixed(1)} KB. Content cannot be displayed inline.]`,
  };
}

/**
 * A tool that loads the artifacts and adds them to the session.
 */
export class LoadArtifactsTool extends BaseTool {
  constructor() {
    super({
      name: 'load_artifacts',
      description: `Loads artifacts into the session for this request.\n\nNOTE: Call when you need access to artifacts (for example, uploads saved by the web UI).`,
    });
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          artifact_names: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
            description: 'The names of the artifacts to load.',
          },
        },
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const artifactNames = (args['artifact_names'] as string[]) || [];
    return {
      artifact_names: artifactNames,
      status:
        'artifact contents temporarily inserted and removed. to access these artifacts, call load_artifacts tool again.',
    };
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);
    await this.appendArtifactsToLlmRequest(
      request.toolContext,
      request.llmRequest,
    );
  }

  private async appendArtifactsToLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    if (!toolContext.invocationContext.artifactService) {
      return;
    }

    const artifactNames = await toolContext.listArtifacts();
    if (!artifactNames || artifactNames.length === 0) {
      return;
    }

    appendInstructions(llmRequest, [
      `You have a list of artifacts:\n  ${JSON.stringify(
        artifactNames,
      )}\n\n  When the user asks questions about any of the artifacts, you should call the\n  \`load_artifacts\` function to load the artifact. Always call load_artifacts\n  before answering questions related to the artifacts, regardless of whether the\n  artifacts have been loaded before. Do not depend on prior answers about the\n  artifacts.`,
    ]);

    const contents = llmRequest.contents;
    if (contents && contents.length > 0) {
      const lastContent = contents[contents.length - 1];
      if (
        lastContent.role === 'user' &&
        lastContent.parts &&
        lastContent.parts.length > 0
      ) {
        const functionResponsePart = lastContent.parts[0];
        const functionResponse = functionResponsePart.functionResponse;

        if (functionResponse && functionResponse.name === 'load_artifacts') {
          const response =
            (functionResponse.response as Record<string, unknown>) || {};
          const namesToLoad = (response['artifact_names'] as string[]) || [];

          for (const artifactName of namesToLoad) {
            let artifact = await toolContext.loadArtifact(artifactName);

            if (!artifact && !artifactName.startsWith('user:')) {
              const prefixedName = `user:${artifactName}`;
              artifact = await toolContext.loadArtifact(prefixedName);
            }

            if (!artifact) {
              logger.warn(`Artifact "${artifactName}" not found, skipping`);
              continue;
            }

            const artifactPart = asSafePartForLlm(artifact, artifactName);

            llmRequest.contents.push({
              role: 'user',
              parts: [{text: `Artifact ${artifactName} is:`}, artifactPart],
            });
          }
        }
      }
    }
  }
}

/**
 * A global instance of {@link LoadArtifactsTool}.
 */
export const LOAD_ARTIFACTS = new LoadArtifactsTool();
