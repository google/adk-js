/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

@experimental
export class SearchSkillsTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    if (!toolset.registry) {
      throw new Error('SearchSkillsTool requires a configured skill registry.');
    }
    super({
      name: 'search_skills',
      description:
        toolset.registry.searchToolDescription?.() ||
        'Searches for relevant skills in the registry based on a semantic or keyword query.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'Semantic or keyword search query.',
          },
        },
        required: ['query'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const query = args['query'] as string;
    if (!query) {
      return {
        error: "Argument 'query' is required.",
        error_code: 'INVALID_ARGUMENTS',
      };
    }

    try {
      const results = await this.toolset.registry!.searchSkills(query);
      return results.filter((r) => {
        if (this.toolset.skills[r.name]) {
          logger.warn(
            `Skill naming conflict: skill '${r.name}' already exists locally. Registry skill is filtered.`,
          );
          return false;
        }
        return true;
      });
    } catch (e: unknown) {
      return {
        error: `Failed to search skills from registry: ${(e as Error).message || e}`,
        error_code: 'REGISTRY_ERROR',
      };
    }
  }
}
