/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {Context} from '../agents/context.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {BaseCodeExecutor} from '../code_executors/base_code_executor.js';
import {appendInstructions, LlmRequest} from '../models/llm_request.js';
import {Skill} from '../skills/models.js';
import {formatSkillsAsXml} from '../skills/prompt.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';
import {BaseToolset} from './base_toolset.js';

const DEFAULT_SCRIPT_TIMEOUT = 300;
const MAX_SKILL_PAYLOAD_BYTES = 16 * 1024 * 1024; // 16 MB

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

function guessMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
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
  };
  return map[ext] || 'application/octet-stream';
}

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
    };
  }
}

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

    if (resourcePath.startsWith('references/')) {
      const refName = resourcePath.substring('references/'.length);
      content = skill.resources.references[refName];
    } else if (resourcePath.startsWith('assets/')) {
      const assetName = resourcePath.substring('assets/'.length);
      content = skill.resources.assets[assetName];
    } else if (resourcePath.startsWith('scripts/')) {
      const scriptName = resourcePath.substring('scripts/'.length);
      const script = skill.resources.scripts[scriptName];
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
      content: content,
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

          let content: string | Buffer | undefined;
          if (resourcePath.startsWith('references/')) {
            content = skill.resources.references[resourcePath.substring('references/'.length)];
          } else if (resourcePath.startsWith('assets/')) {
            content = skill.resources.assets[resourcePath.substring('assets/'.length)];
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
              "The relative path to the script (e.g., 'scripts/setup.py').",
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
    const scriptArgs = (args['args'] as Record<string, any>) || {};

    if (!skillName) {
      return {
        error: 'Skill name is required.',
        error_code: 'MISSING_SKILL_NAME',
      };
    }
    if (!scriptPath) {
      return {
        error: 'Script path is required.',
        error_code: 'MISSING_SCRIPT_PATH',
      };
    }

    const skill = this.toolset.getSkill(skillName);
    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        error_code: 'SKILL_NOT_FOUND',
      };
    }

    const relScriptPath = scriptPath.startsWith('scripts/')
      ? scriptPath.substring('scripts/'.length)
      : scriptPath;
    let script = skill.resources.scripts[relScriptPath];
    if (!script) {
      script = skill.resources.scripts[scriptPath];
    }

    if (!script) {
      return {
        error: `Script '${scriptPath}' not found in skill '${skillName}'.`,
        error_code: 'SCRIPT_NOT_FOUND',
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
        error_code: 'NO_CODE_EXECUTOR',
      };
    }

    const wrapperCode = this.buildWrapperCode(
      skill,
      scriptPath,
      scriptArgs,
      this.toolset.scriptTimeout,
    );
    if (!wrapperCode) {
      return {
        error: 'Unsupported script type. Supported types: .py, .sh, .bash',
        error_code: 'UNSUPPORTED_SCRIPT_TYPE',
      };
    }

    try {
      const result = await codeExecutor.executeCode({
        invocationContext: toolContext.invocationContext,
        codeExecutionInput: {code: wrapperCode, inputFiles: []},
      });

      let stdout = result.stdout || '';
      let stderr = result.stderr || '';
      let rc = 0;
      let status = 'success';

      const isShell =
        scriptPath.endsWith('.sh') || scriptPath.endsWith('.bash');
      if (isShell && stdout) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && parsed.__shell_result__) {
            stdout = parsed.stdout || '';
            stderr = parsed.stderr || '';
            rc = parsed.returncode || 0;
            if (rc !== 0 && !stderr) {
              stderr = `Exit code ${rc}`;
            }
          }
        } catch (e) {
          // skip
        }
      }

      if (rc !== 0 || (stderr && !stdout)) {
        status = 'error';
      } else if (stderr) {
        status = 'warning';
      }

      return {
        skill_name: skillName,
        script_path: scriptPath,
        stdout,
        stderr,
        status,
      };
    } catch (e: any) {
      return {
        error: `Failed to execute script '${scriptPath}': ${e.message}`,
        error_code: 'EXECUTION_ERROR',
      };
    }
  }

  private buildWrapperCode(
    skill: Skill,
    scriptPath: string,
    scriptArgs: Record<string, any>,
    timeout: number,
  ): string | null {
    const ext = scriptPath.split('.').pop()?.toLowerCase() || '';
    if (!scriptPath.startsWith('scripts/')) {
      scriptPath = `scripts/${scriptPath}`;
    }

    const filesDict: Record<string, {type: 'text' | 'binary'; data: string}> =
      {};

    for (const refName of Object.keys(skill.resources.references)) {
      const content = skill.resources.references[refName];
      if (content !== undefined) {
        if (typeof content === 'string') {
          filesDict[`references/${refName}`] = {type: 'text', data: content};
        } else {
          filesDict[`references/${refName}`] = {
            type: 'binary',
            data: content.toString('hex'),
          };
        }
      }
    }

    for (const assetName of Object.keys(skill.resources.assets)) {
      const content = skill.resources.assets[assetName];
      if (content !== undefined) {
        if (typeof content === 'string') {
          filesDict[`assets/${assetName}`] = {type: 'text', data: content};
        } else {
          filesDict[`assets/${assetName}`] = {
            type: 'binary',
            data: content.toString('hex'),
          };
        }
      }
    }

    for (const scrName of Object.keys(skill.resources.scripts)) {
      const scr = skill.resources.scripts[scrName];
      if (scr !== undefined) {
        filesDict[`scripts/${scrName}`] = {type: 'text', data: scr.src};
      }
    }

    const codeLines = [
      'import os',
      'import tempfile',
      'import sys',
      'import json as _json',
      'import subprocess',
      'import runpy',
      `_files = ${JSON.stringify(filesDict)}`,
      'def _materialize_and_run():',
      '  _orig_cwd = os.getcwd()',
      '  with tempfile.TemporaryDirectory() as td:',
      '    for rel_path, info in _files.items():',
      '      full_path = os.path.join(td, rel_path)',
      '      os.makedirs(os.path.dirname(full_path), exist_ok=True)',
      "      if info['type'] == 'binary':",
      "        content = bytes.fromhex(info['data'])",
      "        mode = 'wb'",
      '      else:',
      "        content = info['data']",
      "        mode = 'w'",
      '      with open(full_path, mode) as f:',
      '        f.write(content)',
      '    os.chdir(td)',
      '    try:',
    ];

    if (ext === 'py') {
      const argvList = [scriptPath];
      for (const [k, v] of Object.entries(scriptArgs)) {
        argvList.push(`--${k}`, String(v));
      }
      codeLines.push(
        `      sys.argv = ${JSON.stringify(argvList)}`,
        '      try:',
        `        runpy.run_path(${JSON.stringify(scriptPath)}, run_name='__main__')`,
        '      except SystemExit as e:',
        '        if e.code is not None and e.code != 0:',
        '          raise e',
      );
    } else if (ext === 'sh' || ext === 'bash') {
      const arr = ['bash', scriptPath];
      for (const [k, v] of Object.entries(scriptArgs)) {
        arr.push(`--${k}`, String(v));
      }
      codeLines.push(
        '      try:',
        '        _r = subprocess.run(',
        `          ${JSON.stringify(arr)},`,
        '          capture_output=True, text=True,',
        `          timeout=${timeout}, cwd=td,`,
        '        )',
        '        print(_json.dumps({',
        "            '__shell_result__': True,",
        "            'stdout': _r.stdout,",
        "            'stderr': _r.stderr,",
        "            'returncode': _r.returncode,",
        '        }))',
        '      except subprocess.TimeoutExpired as _e:',
        '        print(_json.dumps({',
        "            '__shell_result__': True,",
        "            'stdout': _e.stdout or '',",
        `            'stderr': 'Timed out after ${timeout}s',`,
        "            'returncode': -1,",
        '        }))',
      );
    } else {
      return null;
    }

    codeLines.push(
      '    finally:',
      '      os.chdir(_orig_cwd)',
      '_materialize_and_run()',
    );

    return codeLines.join('\n');
  }
}

export class SkillToolset extends BaseToolset {
  public skills: Record<string, Skill>;
  private tools: BaseTool[];
  public codeExecutor?: BaseCodeExecutor;
  public scriptTimeout: number;
  public additionalTools: Array<BaseTool | BaseToolset>;

  constructor(
    skills: Skill[],
    options: {
      codeExecutor?: BaseCodeExecutor;
      scriptTimeout?: number;
      additionalTools?: Array<BaseTool | BaseToolset>;
    } = {},
  ) {
    super([]); // Pass empty filter to base
    this.skills = Object.fromEntries(skills.map((s) => [s.name, s]));
    this.codeExecutor = options.codeExecutor;
    this.scriptTimeout = options.scriptTimeout || DEFAULT_SCRIPT_TIMEOUT;
    this.additionalTools = options.additionalTools || [];

    this.tools = [
      new ListSkillsTool(this),
      new LoadSkillTool(this),
      new LoadSkillResourceTool(this),
      new RunSkillScriptTool(this),
    ];
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const dynamicTools = await this.resolveAdditionalTools(context);
    return [...this.tools, ...dynamicTools];
  }

  override async close(): Promise<void> {
    // No resources to release
  }

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
