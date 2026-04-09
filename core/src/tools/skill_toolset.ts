/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {appendInstructions, LlmRequest} from '../models/llm_request.js';
import {formatSkillsAsXml} from '../skills/prompt.js';
import {Skill} from '../skills/skill.js';
import {experimental} from '../utils/experimental.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';
import {BaseToolset} from './base_toolset.js';

const BINARY_FILE_DETECTED_MSG =
  'Binary file detected. The content has been injected into the conversation history for you to analyze.';

const DEFAULT_SKILL_SYSTEM_INSTRUCTION = `You can use specialized 'skills' to help you with complex tasks. You MUST use the skill tools to interact with these skills.

Skills are folders of instructions and resources that extend your capabilities for specialized tasks. Each skill folder contains:
- **SKILL.md** (required): The main instruction file with skill metadata and detailed markdown instructions.
- **references/** (Optional): Additional documentation or examples for skill usage.
- **assets/** (Optional): Templates, scripts or other resources used by the skill.
- **scripts/** (Optional): Executable scripts that can be run via bash.

This is very important:

1. If a skill seems relevant to the current user query, you MUST use the \`load_skill\` tool with \`name="<SKILL_NAME>"\` to read its full instructions before proceeding.
2. Once you have read the instructions, follow them exactly as documented before replying to the user. For example, If the instruction lists multiple steps, please make sure you complete all of them in order.
3. The \`load_skill_resource\` tool is for viewing files within a skill's directory (e.g., \`references/*\`, \`assets/*\`, \`scripts/*\`). Do NOT use other tools to access these files.
4. Use \`run_skill_script\` to run scripts from a skill's \`scripts/\` directory. Use \`load_skill_resource\` to view script content first if needed.
`;

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
    const resourcePath = args['path'] as string;

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

@experimental
export class SkillToolset extends BaseToolset {
  public skills: Record<string, Skill>;
  private tools: BaseTool[];
  public additionalTools: Array<BaseTool | BaseToolset>;

  constructor(
    skills: Skill[],
    options: {
      additionalTools?: Array<BaseTool | BaseToolset>;
    } = {},
  ) {
    super([], 'adk_skill_toolset'); // Pass empty filter to base
    this.skills = Object.fromEntries(
      skills.map((s) => [s.frontmatter.name, s]),
    );
    this.additionalTools = options.additionalTools || [];

    this.tools = [
      new ListSkillsTool(this),
      new LoadSkillTool(this),
      new LoadSkillResourceTool(this),
    ];
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const dynamicTools = await this.resolveAdditionalTools(context);
    return [...this.tools, ...dynamicTools];
  }

  override async close(): Promise<void> {}

  getSkill(name: string): Skill | undefined {
    return this.skills[name];
  }

  override async processLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(toolContext, llmRequest);

    const skills = Object.values(this.skills);
    const skillsXml = formatSkillsAsXml(skills);

    appendInstructions(llmRequest, [
      DEFAULT_SKILL_SYSTEM_INSTRUCTION,
      skillsXml,
    ]);
  }

  private async resolveAdditionalTools(
    context?: ReadonlyContext,
  ): Promise<BaseTool[]> {
    if (!context) return [];

    const agentName = context.agentName;
    const stateKey = `_adk_activated_skill_${agentName}`;
    const activatedSkills = context.state.get<string[]>(stateKey) || [];

    if (activatedSkills.length === 0) return [];

    const additionalToolNames = new Set<string>();
    for (const skillName of activatedSkills) {
      const skill = this.skills[skillName];
      if (skill && skill.frontmatter.metadata) {
        const tools = skill.frontmatter.metadata[
          'adk_additional_tools'
        ] as string[];
        if (tools) {
          tools.forEach((t) => additionalToolNames.add(t));
        }
      }
    }

    if (additionalToolNames.size === 0) return [];

    const candidateTools: Record<string, BaseTool> = {};
    for (const toolUnion of this.additionalTools) {
      if (toolUnion instanceof BaseTool) {
        candidateTools[toolUnion.name] = toolUnion;
      } else if (toolUnion instanceof BaseToolset) {
        const tsTools = await toolUnion.getTools(context);
        tsTools.forEach((t) => (candidateTools[t.name] = t));
      }
    }

    const resolvedTools: BaseTool[] = [];
    const existingNames = new Set(this.tools.map((t) => t.name));

    for (const name of additionalToolNames) {
      if (candidateTools[name]) {
        const tool = candidateTools[name];
        if (!existingNames.has(tool.name)) {
          resolvedTools.push(tool);
          existingNames.add(tool.name);
        }
      }
    }

    return resolvedTools;
  }
}
