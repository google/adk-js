/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseCodeExecutor} from '../../code_executors/base_code_executor.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {formatSkillsAsXml} from '../../skills/prompt.js';
import {Skill} from '../../skills/skill.js';
import {SkillRegistry} from '../../skills/skill_registry.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset} from '../base_toolset.js';
import {ListSkillsTool} from './list_skills_tool.js';
import {LoadSkillResourceTool} from './load_skill_resource_tool.js';
import {LoadSkillTool} from './load_skill_tool.js';
import {RunSkillInlineScriptTool} from './run_skill_inline_script_tool.js';
import {RunSkillScriptTool} from './run_skill_script_tool.js';
import {SearchSkillsTool} from './search_skills_tool.js';

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

@experimental
export class SkillToolset extends BaseToolset {
  public skills: Record<string, Skill>;
  private tools: BaseTool[];
  public additionalTools: Array<BaseTool | BaseToolset>;
  public codeExecutor?: BaseCodeExecutor;
  public registry?: SkillRegistry;
  private readonly scriptOutputDir?: string;
  private toolCache = new Map<string, BaseTool[]>();
  private fetchedSkillCache = new Map<string, Map<string, Skill>>();
  private tempOutputDir?: Promise<string>;

  constructor(
    skills: Record<string, Skill> | Skill[],
    options: {
      codeExecutor?: BaseCodeExecutor;
      additionalTools?: Array<BaseTool | BaseToolset>;
      registry?: SkillRegistry;
      /**
       * Whether to expose the `run_skill_inline_script` tool, which executes
       * model-provided script content in the configured code executor. This is
       * disabled by default because arbitrary inline-script execution is a
       * sensitive capability; opt in explicitly by setting this to `true`.
       * Execution additionally remains gated behind a human-in-the-loop
       * confirmation.
       */
      allowInlineScripts?: boolean;
      /**
       * Directory that files produced by `run_skill_script` /
       * `run_skill_inline_script` are written into. Output file names come from
       * the executed script, so this must be a directory dedicated to
       * throwaway script output — never the application's working directory or
       * a source tree.
       *
       * Defaults to a private, randomly named directory created under the OS
       * temp dir on first use. Nothing removes that directory: `close()` runs
       * once per invocation on a toolset instance that concurrent invocations
       * share (see `Runner`), so it cannot tell whose output is still in use.
       * Set this to own the location and the lifetime of the output.
       */
      scriptOutputDir?: string;
    } = {},
  ) {
    super([], 'adk_skill_toolset');
    this.skills = Array.isArray(skills)
      ? Object.fromEntries(skills.map((s) => [s.frontmatter.name, s]))
      : skills;
    this.codeExecutor = options.codeExecutor;
    this.additionalTools = options.additionalTools || [];
    this.registry = options.registry;
    this.scriptOutputDir = options.scriptOutputDir;

    this.tools = [
      new ListSkillsTool(this),
      new LoadSkillTool(this),
      new LoadSkillResourceTool(this),
      new RunSkillScriptTool(this),
    ];

    // Inline-script execution is opt-in: only expose the tool when explicitly
    // enabled, so agents are secure-by-default.
    if (options.allowInlineScripts) {
      this.tools.push(new RunSkillInlineScriptTool(this));
    }

    if (this.registry) {
      this.tools.push(new SearchSkillsTool(this));
    }
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const dynamicTools = await this.resolveAdditionalTools(context);
    return [...this.tools, ...dynamicTools];
  }

  override async close(): Promise<void> {
    this.fetchedSkillCache.clear();
    await this.registry?.close?.();
  }

  getSkill(name: string): Skill | undefined {
    return this.skills[name];
  }

  /**
   * Resolves the directory that script output files are materialized into.
   *
   * Script output file names are attacker-influenced (a prompt-injected skill
   * controls what its script writes), so they must never be resolved against
   * the host application's working directory. When no `scriptOutputDir` was
   * configured this hands back a private temp directory instead, created once
   * and reused for the lifetime of the toolset.
   */
  getScriptOutputDir(): Promise<string> {
    if (this.scriptOutputDir) {
      // mkdir is idempotent, so it can just run per call; only the temp
      // directory needs to be remembered, since its name is generated.
      const dir = path.resolve(this.scriptOutputDir);
      return fs.mkdir(dir, {recursive: true}).then(() => dir);
    }

    // mkdtemp names the directory itself and creates it exclusively at 0o700,
    // so another local user can neither predict the path nor pre-create it as
    // a symlink to somewhere else.
    return (this.tempOutputDir ??= fs.mkdtemp(
      path.join(os.tmpdir(), 'adk_skill_script_output_'),
    ));
  }

  async getOrFetchSkill(
    name: string,
    invocationId?: string,
  ): Promise<Skill | undefined> {
    if (this.skills[name]) {
      return this.skills[name];
    }
    if (!this.registry) {
      return undefined;
    }

    const contextKey = invocationId || 'default';
    if (!this.fetchedSkillCache.has(contextKey)) {
      this.fetchedSkillCache.set(contextKey, new Map());
    }

    const cache = this.fetchedSkillCache.get(contextKey)!;
    if (cache.has(name)) {
      return cache.get(name)!;
    }

    try {
      const skill = await this.registry.getSkill(name);
      cache.set(name, skill);
      return skill;
    } catch (e: unknown) {
      logger.warn(`Failed to fetch skill '${name}' from registry: ${e}`);
      throw e;
    }
  }

  override async processLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(toolContext, llmRequest);

    const skills = Object.values(this.skills);
    const skillsXml = formatSkillsAsXml(skills);

    const instructions = [DEFAULT_SKILL_SYSTEM_INSTRUCTION, skillsXml];

    if (this.registry) {
      instructions.push(
        '\nIf the locally available skills are not sufficient to complete your task, you can use the `search_skills` tool to discover additional skills from the registry.',
      );
    }

    appendInstructions(llmRequest, instructions);
  }

  private async resolveAdditionalTools(
    context?: ReadonlyContext,
  ): Promise<BaseTool[]> {
    if (!context) return [];

    const agentName = context.agentName;
    const stateKey = `_adk_activated_skill_${agentName}`;
    const activatedSkills = context.state.get<string[]>(stateKey) || [];

    if (activatedSkills.length === 0) return [];

    const cacheKey = `${agentName}:${activatedSkills.join(',')}`;
    if (this.toolCache.has(cacheKey)) {
      return this.toolCache.get(cacheKey)!;
    }

    const additionalToolNames = new Set<string>();
    for (const skillName of activatedSkills) {
      const skill = await this.getOrFetchSkill(skillName, context.invocationId);
      if (skill && skill.frontmatter.metadata) {
        const tools = skill.frontmatter.metadata[
          'adk_additional_tools'
        ] as string[];
        if (tools) {
          tools.forEach((t) => additionalToolNames.add(t));
        }
      }
    }

    if (additionalToolNames.size === 0) {
      this.toolCache.set(cacheKey, []);
      return [];
    }

    const candidateTools: Record<string, BaseTool> = {};
    for (const toolUnion of this.additionalTools) {
      if (toolUnion instanceof BaseTool) {
        if (candidateTools[toolUnion.name]) {
          throw new Error(`Duplicate tool name: ${toolUnion.name}`);
        }

        candidateTools[toolUnion.name] = toolUnion;
      } else if (toolUnion instanceof BaseToolset) {
        const tsTools = await toolUnion.getTools(context);

        for (const t of tsTools) {
          if (candidateTools[t.name]) {
            throw new Error(`Duplicate tool name: ${t.name}`);
          }

          candidateTools[t.name] = t;
        }
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

    this.toolCache.set(cacheKey, resolvedTools);
    return resolvedTools;
  }
}
