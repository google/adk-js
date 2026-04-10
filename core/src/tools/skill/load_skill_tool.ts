/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

@experimental
export class LoadSkillTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    super({
      name: 'load_skill',
      description: 'Loads the SKILL.md instructions for a given skill.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: {
            type: Type.STRING,
            description: 'The name of the skill to load.',
          },
        },
        required: ['name'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const skillName = args['name'] as string;
    if (!skillName) {
      return {
        error: 'Skill name is required.',
        error_code: 'MISSING_SKILL_NAME',
      };
    }

    const skill = this.toolset.getSkill(skillName);
    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        error_code: 'SKILL_NOT_FOUND',
      };
    }

    // Record skill activation in agent state
    const agentName = toolContext.invocationContext.agent.name;
    const stateKey = `_adk_activated_skill_${agentName}`;

    const currentActivated = toolContext.state.get<string[]>(stateKey) || [];
    if (!currentActivated.includes(skillName)) {
      toolContext.state.set(stateKey, [...currentActivated, skillName]);
    }

    return {
      skill_name: skillName,
      instructions: skill.instructions,
      frontmatter: skill.frontmatter,
      resources: skill.resources,
    };
  }
}
