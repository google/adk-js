/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {Context} from '../agents/context.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * A single profile entry returned by a profile-capable memory service.
 */
export interface ProfileMemoryEntry {
  schemaId?: string;
  profile?: Record<string, unknown>;
}

/**
 * Interface for memory services capable of retrieving user profiles
 * (such as {@link VertexAiMemoryBankService}).
 */
export interface ProfileMemoryService {
  retrieveProfiles(request: {
    appName: string;
    userId: string;
  }): Promise<ProfileMemoryEntry[]>;
}

/**
 * A tool that loads all user profiles from Vertex AI Memory Bank.
 */
export class VertexAiLoadProfilesTool extends BaseTool {
  constructor(private readonly memoryService: ProfileMemoryService) {
    super({
      name: 'load_profiles',
      description:
        'Loads all user profiles for the current user from Vertex AI Memory Bank.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    if (isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL)) {
      return {
        name: this.name,
        description: this.description,
        parametersJsonSchema: {
          type: 'object',
          properties: {},
        },
      };
    }
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    };
  }

  /**
   * Loads all user profiles for the current user from Vertex AI Memory Bank.
   */
  async loadProfiles(
    toolContext: Context,
  ): Promise<{profiles: Array<Record<string, unknown>>}> {
    const appName =
      toolContext.session?.appName ??
      toolContext.invocationContext?.session?.appName ??
      '';
    const userId = toolContext.userId;
    const profiles = await this.memoryService.retrieveProfiles({
      appName,
      userId,
    });
    return {
      profiles: profiles
        .filter(
          (
            profile,
          ): profile is ProfileMemoryEntry & {
            profile: Record<string, unknown>;
          } =>
            profile?.profile != null && Object.keys(profile.profile).length > 0,
        )
        .map((profile) => profile.profile),
    };
  }

  override async runAsync({
    toolContext,
  }: RunAsyncToolRequest): Promise<{profiles: Array<Record<string, unknown>>}> {
    return this.loadProfiles(toolContext);
  }
}
