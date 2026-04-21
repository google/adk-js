/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import * as path from 'node:path';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {
  CodeExecutionLanguage,
  File,
} from '../../code_executors/code_execution_utils.js';
import {Script, Skill} from '../../skills/skill.js';
import {experimental} from '../../utils/experimental.js';
import {
  getMimeTypeAndEncoding,
  getScriptLanguageByExtension,
} from '../../utils/file_extension_utils.js';
import {materializeFiles} from '../../utils/file_utils.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

@experimental
export class RunSkillScriptTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    super({
      name: 'run_skill_script',
      description: "Executes a script from a skill's scripts/ directory.",
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          skill_name: {
            type: Type.STRING,
            description: 'The name of the skill.',
          },
          script_path: {
            type: Type.STRING,
            description:
              "The relative path to the script (e.g., 'scripts/setup.js').",
          },
          args: {
            type: Type.OBJECT,
            description:
              'Optional arguments to pass to the script as key-value pairs.',
          },
        },
        required: ['skill_name', 'script_path'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const skillName = args['skill_name'] as string;
    const scriptPath = args['script_path'] as string;
    const scriptArgs =
      (args['args'] as Record<string, string | number | boolean>) || {};

    if (!skillName) {
      return {
        error: 'Skill name is required.',
        errorCode: 'MISSING_SKILL_NAME',
      };
    }
    if (!scriptPath) {
      return {
        error: 'Script path is required.',
        errorCode: 'MISSING_SCRIPT_PATH',
      };
    }

    const skill = this.toolset.getSkill(skillName);
    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        errorCode: 'SKILL_NOT_FOUND',
      };
    }

    const relScriptPath = scriptPath.startsWith('scripts/')
      ? scriptPath.substring('scripts/'.length)
      : scriptPath;
    let script = skill.resources?.scripts?.[relScriptPath];
    if (!script) {
      script = skill.resources?.scripts?.[scriptPath];
    }

    if (!script) {
      return {
        error: `Script '${scriptPath}' not found in skill '${skillName}'.`,
        errorCode: 'SCRIPT_NOT_FOUND',
      };
    }

    let codeExecutor = this.toolset.codeExecutor;
    if (!codeExecutor) {
      const agent = toolContext.invocationContext.agent;
      if (isLlmAgent(agent)) {
        codeExecutor = agent.codeExecutor;
      }
    }

    if (!codeExecutor) {
      return {
        error: 'No code executor configured.',
        errorCode: 'NO_CODE_EXECUTOR',
      };
    }

    try {
      const language = getScriptLanguageByExtension(path.extname(scriptPath));
      const result = await codeExecutor.executeCode({
        invocationContext: toolContext.invocationContext,
        codeExecutionInput: {
          code: buildWrapperCode(scriptPath, language),
          inputFiles: getSkillResourceFiles(skill),
          language,
          args: scriptArgs,
        },
      });

      // Final filename could be different if there was a collision, so update the result.
      result.outputFiles = await materializeFiles(result.outputFiles);

      return result;
    } catch (e: unknown) {
      return {
        error: `Failed to execute script '${scriptPath}': ${(e as Error).message}`,
        errorCode: 'EXECUTION_ERROR',
      };
    }
  }
}

function buildWrapperCode(
  scriptPath: string,
  language: CodeExecutionLanguage,
): string {
  switch (language) {
    case CodeExecutionLanguage.JAVASCRIPT:
      return `require('./${scriptPath}');`;
    case CodeExecutionLanguage.TYPESCRIPT:
      return `require('ts-node/register');\nrequire('./${scriptPath}');`;
    case CodeExecutionLanguage.PYTHON:
      return `import runpy\nrunpy.run_path('./${scriptPath}', run_name='__main__')`;
    case CodeExecutionLanguage.SHELL:
      return `source ./${scriptPath} "$@"`;
    case CodeExecutionLanguage.POWERSHELL:
      return `& .\\${scriptPath.replace(/\//g, '\\\\')} $args`;
    case CodeExecutionLanguage.WINDOWS_CMD:
      return `call .\\${scriptPath.replace(/\//g, '\\\\')} %*`;
    default:
      throw new Error(`Unsupported wrapper language: ${language}`);
  }
}

export function getSkillResourceFiles(skill: Skill): File[] {
  const files: File[] = [];

  for (const resourceType of ['references', 'assets', 'scripts']) {
    const resources =
      skill.resources?.[resourceType as keyof Skill['resources']] ?? {};

    for (const resourceName of Object.keys(resources)) {
      const content =
        resources[resourceName as keyof typeof resources] ?? undefined;

      if (content === undefined) {
        continue;
      }

      let fileContent: string | Buffer | undefined = undefined;
      if (typeof content === 'string' || Buffer.isBuffer(content)) {
        fileContent = content;
      } else if (
        typeof content === 'object' &&
        content !== null &&
        'src' in content &&
        typeof (content as Script).src === 'string'
      ) {
        fileContent = (content as Script).src;
      }

      if (fileContent === undefined) {
        continue;
      }

      const ext = path.extname(resourceName).toLowerCase();
      const {encoding, mimeType} = getMimeTypeAndEncoding(ext);
      files.push({
        name: `${resourceType}/${resourceName}`,
        content: Buffer.from(fileContent).toString(encoding),
        contentEncoding: encoding,
        mimeType,
      });
    }
  }

  return files;
}
