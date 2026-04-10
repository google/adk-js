/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {formatSkillsAsXml} from '../../skills/prompt.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

@experimental
export class ListSkillsTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    super({
      name: 'list_skills',
      description:
        'Lists all available skills with their names and descriptions.',
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

  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    const skills = Object.values(this.toolset.skills);
    return formatSkillsAsXml(skills);
  }
}
