/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {MemoryProfile} from '@google-cloud/vertexai/build/src/genai/types.js';
import {FunctionDeclaration, Type} from '@google/genai';

import {Context} from '../agents/context.js';
import type {RetrieveProfilesRequest} from '../memory/vertex_ai_memory_bank_service.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Interface for memory services capable of retrieving user profiles
 * (such as {@link VertexAiMemoryBankService}).
 */
export interface ProfileMemoryService {
  retrieveProfiles(request: RetrieveProfilesRequest): Promise<MemoryProfile[]>;
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
    const appName = toolContext.session.appName;
    const userId = toolContext.userId;
    const profiles = await this.memoryService.retrieveProfiles({
      appName,
      userId,
    });
    return {
      profiles: profiles.flatMap((p) =>
        p.profile && Object.keys(p.profile).length > 0 ? [p.profile] : [],
      ),
    };
  }

  override async runAsync({
    toolContext,
  }: RunAsyncToolRequest): Promise<{profiles: Array<Record<string, unknown>>}> {
    return this.loadProfiles(toolContext);
  }
}
