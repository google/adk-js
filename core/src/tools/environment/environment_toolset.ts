/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {LlmRequest, appendInstructions} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {ENVIRONMENT_INSTRUCTION} from './constants.js';

import {EditFileTool} from './edit_file_tool.js';
import {ExecuteTool} from './execute_tool.js';
import {ReadFileTool} from './read_file_tool.js';
import {WriteFileTool} from './write_file_tool.js';

export interface EnvironmentToolsetParams {
  workingDir: string;
  maxOutputChars?: number;
  toolFilter?: ToolPredicate | string[];
  /**
   * The shell {@link ExecuteTool} hands commands to. Defaults to `/bin/sh` on
   * POSIX and `cmd.exe` on Windows.
   */
  shell?: string;
}

/**
 * Toolset providing tools to interact with an environment.
 *
 * Tools provided:
 *   - Execute -- run shell commands
 *   - ReadFile -- read file contents
 *   - EditFile -- surgical text replacement
 *   - WriteFile -- create/overwrite files
 *
 * The toolset injects an environment-level system instruction on each
 * LLM call that establishes environment identity and tool selection rules.
 */
@experimental
export class EnvironmentToolset extends BaseToolset {
  private readonly workingDir: string;
  private readonly maxOutputChars?: number;
  private readonly shell?: string;
  private tools: BaseTool[] | undefined;

  constructor(params: EnvironmentToolsetParams) {
    super(params.toolFilter || []);
    this.workingDir = params.workingDir;
    this.maxOutputChars = params.maxOutputChars;
    this.shell = params.shell;
  }

  override async getTools(context?: Context): Promise<BaseTool[]> {
    if (!this.tools) {
      this.tools = [
        new ExecuteTool({
          workingDir: this.workingDir,
          maxOutputChars: this.maxOutputChars,
          shell: this.shell,
        }),
        new ReadFileTool({
          workingDir: this.workingDir,
          maxOutputChars: this.maxOutputChars,
        }),
        new EditFileTool({workingDir: this.workingDir}),
        new WriteFileTool({workingDir: this.workingDir}),
      ];
    }
    if (context) {
      return this.tools.filter((t) => this.isToolSelected(t, context));
    }
    return this.tools;
  }

  override async processLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    const instruction = ENVIRONMENT_INSTRUCTION.replace(
      '{working_dir}',
      this.workingDir,
    );
    appendInstructions(llmRequest, [instruction]);
  }

  override async close(): Promise<void> {
    // No resources to close currently.
  }
}
