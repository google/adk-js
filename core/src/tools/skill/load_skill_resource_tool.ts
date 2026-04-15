/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import path from 'node:path';
import {experimental} from '../../utils/experimental.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

const BINARY_FILE_DETECTED_MSG =
  'Binary file detected. The content has been injected into the conversation history for you to analyze.';

const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  'pdf': 'application/pdf',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'csv': 'text/csv',
  'json': 'application/json',
  'xml': 'application/xml',
  'sh': 'text/x-shellscript',
  'bash': 'text/x-shellscript',
  'py': 'text/x-python',
  'js': 'text/javascript',
  'cjs': 'text/javascript',
  'mjs': 'text/javascript',
  'ts': 'text/javascript',
  'cts': 'text/javascript',
  'mts': 'text/javascript',
};

function guessMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  return EXTENSION_TO_MIME_TYPE[ext] || 'application/octet-stream';
}

@experimental
export class LoadSkillResourceTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    super({
      name: 'load_skill_resource',
      description:
        'Loads a resource file (from references/, assets/, or scripts/) from within a skill.',
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
          path: {
            type: Type.STRING,
            description:
              "The relative path to the resource (e.g., 'references/my_doc.md', 'assets/template.txt', or 'scripts/setup.sh').",
          },
        },
        required: ['skill_name', 'path'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const skillName = args['skill_name'] as string;
    let resourcePath = args['path'] as string;

    if (!skillName) {
      return {
        error: 'Skill name is required.',
        error_code: 'MISSING_SKILL_NAME',
      };
    }
    if (!resourcePath) {
      return {
        error: 'Resource path is required.',
        error_code: 'MISSING_RESOURCE_PATH',
      };
    }

    resourcePath = path.posix.normalize(resourcePath);

    const skill = this.toolset.getSkill(skillName);
    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        error_code: 'SKILL_NOT_FOUND',
      };
    }

    let content: string | Buffer | undefined;
    const skillResources = skill.resources || {};

    if (resourcePath.startsWith('references/')) {
      const refName = resourcePath.substring('references/'.length);
      content = skillResources.references?.[refName];
    } else if (resourcePath.startsWith('assets/')) {
      const assetName = resourcePath.substring('assets/'.length);
      content = skillResources.assets?.[assetName];
    } else if (resourcePath.startsWith('scripts/')) {
      const scriptName = resourcePath.substring('scripts/'.length);
      const script = skillResources.scripts?.[scriptName];
      if (script) {
        content = script.src;
      }
    } else {
      return {
        error: "Path must start with 'references/', 'assets/', or 'scripts/'.",
        error_code: 'INVALID_RESOURCE_PATH',
      };
    }

    if (content === undefined) {
      return {
        error: `Resource '${resourcePath}' not found in skill '${skillName}'.`,
        error_code: 'RESOURCE_NOT_FOUND',
      };
    }

    if (Buffer.isBuffer(content)) {
      return {
        skill_name: skillName,
        path: resourcePath,
        status: BINARY_FILE_DETECTED_MSG,
      };
    }

    return {
      skill_name: skillName,
      path: resourcePath,
      content,
    };
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);

    const llmRequest = request.llmRequest;
    if (!llmRequest.contents || llmRequest.contents.length === 0) {
      return;
    }

    const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
    if (lastContent.role !== 'user' || !lastContent.parts) {
      return;
    }

    for (const part of lastContent.parts) {
      if (part.functionResponse && part.functionResponse.name === this.name) {
        const response =
          (part.functionResponse.response as Record<string, unknown>) || {};
        if (response['status'] === BINARY_FILE_DETECTED_MSG) {
          const skillName = response['skill_name'] as string;
          const resourcePath = response['path'] as string;

          const skill = this.toolset.getSkill(skillName);
          if (!skill) continue;
          const skillResources = skill.resources || {};

          let content: string | Buffer | undefined;
          if (resourcePath.startsWith('references/')) {
            content =
              skillResources.references?.[
                resourcePath.substring('references/'.length)
              ];
          } else if (resourcePath.startsWith('assets/')) {
            content =
              skillResources.assets?.[resourcePath.substring('assets/'.length)];
          }

          if (Buffer.isBuffer(content)) {
            const mimeType = guessMimeType(resourcePath);
            llmRequest.contents.push({
              role: 'user',
              parts: [
                {text: `The content of binary file '${resourcePath}' is:`},
                {
                  inlineData: {
                    data: content.toString('base64'),
                    mimeType: mimeType,
                  },
                },
              ],
            });
          }
        }
      }
    }
  }
}
