/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {exec} from 'child_process';
import {promisify} from 'util';

import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {DEFAULT_TIMEOUT_MS, MAX_OUTPUT_CHARS} from './constants.js';
import {truncate} from './utils.js';

const execAsync = promisify(exec);

const _EXECUTE_TOOL_DESCRIPTION = `
Run a shell command in the environment. For running programs, tests, and build
commands ONLY. WARNING: Do NOT use for file reading -- use the ReadFile tool
instead. Shell commands like 'cat, head, tail will produce inferior results.
Good: Execute("node script.js"), Execute("npm test"), Execute("find ...").
Bad: Execute("head ..."), Execute("cat ...").
`;

export interface ExecuteToolParams {
  workingDir: string;
  maxOutputChars?: number;
  executeTimeoutMs?: number;
}

/**
 * ExecuteTool for running shell commands in the environment.
 */
export class ExecuteTool extends BaseTool {
  private readonly workingDir: string;
  private readonly maxOutputChars: number;
  private readonly executeTimeoutMs: number;

  constructor(params: ExecuteToolParams) {
    super({
      name: 'Execute',
      description: _EXECUTE_TOOL_DESCRIPTION,
    });
    this.workingDir = params.workingDir;
    this.maxOutputChars = params.maxOutputChars ?? MAX_OUTPUT_CHARS;
    this.executeTimeoutMs = params.executeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description:
              'The shell command to execute. Chain dependent commands with &&.',
          },
        },
        required: ['command'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const command = args['command'];
    if (typeof command !== 'string' || !command) {
      return {status: 'error', error: '`command` is required.'};
    }

    try {
      const {stdout, stderr} = await execAsync(command, {
        cwd: this.workingDir,
        timeout: this.executeTimeoutMs,
      });

      const result: Record<string, unknown> = {status: 'ok'};
      if (stdout) {
        result['stdout'] = truncate(stdout, this.maxOutputChars);
      }
      if (stderr) {
        result['stderr'] = truncate(stderr, this.maxOutputChars);
      }
      return result;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const result: Record<string, unknown> = {status: 'error'};
      if (e.killed) {
        result['error'] =
          `Command timed out after ${this.executeTimeoutMs / 1000}s.`;
      } else {
        result['exit_code'] = e.code;
        result['error'] = String(e.message);
      }
      if (e.stdout) {
        result['stdout'] = truncate(e.stdout, this.maxOutputChars);
      }
      if (e.stderr) {
        result['stderr'] = truncate(e.stderr, this.maxOutputChars);
      }
      return result;
    }
  }
}
