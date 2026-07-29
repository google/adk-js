/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {ExecException, exec} from 'child_process';
import {promisify} from 'util';

import {Context} from '../../agents/context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {DEFAULT_TIMEOUT_MS, MAX_OUTPUT_CHARS} from './constants.js';
import {toError, truncate} from './utils.js';

const execAsync = promisify(exec);

const EXECUTE_TOOL_DESCRIPTION = `
Run a shell command in the environment. For running programs, tests, and build
commands ONLY. WARNING: Do NOT use for file reading -- use the ReadFile tool
instead. Shell commands like 'cat, head, tail will produce inferior results.
Good: Execute("node script.js"), Execute("npm test"), Execute("find ...").
Bad: Execute("head ..."), Execute("cat ...").
`;

/**
 * Message returned while the tool call is paused waiting for the client to
 * confirm (or reject) the command. Mirrors the intermediate message used by the
 * tool-confirmation flow elsewhere in the codebase (see `SecurityPlugin` and
 * `RunSkillInlineScriptTool`).
 */
const REQUIRE_CONFIRMATION_MESSAGE =
  'This tool call needs external confirmation before completion.';

export interface ExecuteToolParams {
  workingDir: string;
  maxOutputChars?: number;
  executeTimeoutMs?: number;
}

/**
 * The result of an {@link ExecuteTool} call.
 *
 * The field names are part of the response contract the model sees and mirror
 * `adk-python`'s execute tool, hence the snake_case `exit_code`.
 */
export interface ExecuteResult {
  /** `'ok'` when the command exited successfully, `'error'` otherwise. */
  status: 'ok' | 'error';
  /** Captured stdout, truncated to `maxOutputChars`. */
  stdout?: string;
  /** Captured stderr, truncated to `maxOutputChars`. */
  stderr?: string;
  /** Exit code of the command, when it ran and exited non-zero. */
  exit_code?: number;
  /** Why the call failed. Always set when `status` is `'error'`. */
  error?: string;
}

/**
 * The intermediate result returned while an {@link ExecuteTool} call is paused
 * waiting for the client to confirm the command.
 */
export interface ExecuteConfirmationRequired {
  /** The message surfaced to the model while the call is paused. */
  partial: string;
}

/** Everything {@link ExecuteTool.runAsync} can resolve to. */
export type ExecuteToolResult = ExecuteResult | ExecuteConfirmationRequired;

/**
 * ExecuteTool for running shell commands in the environment.
 *
 * The command goes to the host shell, so a model-authored string is arbitrary
 * code execution on the machine running the agent and `workingDir` is not a
 * boundary. Every call therefore passes through the repo's standard
 * tool-confirmation gate before it runs, the same way
 * `RunSkillInlineScriptTool` gates model-provided scripts.
 */
@experimental
export class ExecuteTool extends BaseTool {
  private readonly workingDir: string;
  private readonly maxOutputChars: number;
  private readonly executeTimeoutMs: number;

  constructor(params: ExecuteToolParams) {
    super({
      name: 'Execute',
      description: EXECUTE_TOOL_DESCRIPTION,
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

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<ExecuteToolResult> {
    const command = args['command'];
    if (typeof command !== 'string' || !command) {
      return {status: 'error', error: '`command` is required.'};
    }

    const pending = this.enforceConfirmation(toolContext, command);
    if (pending) {
      return pending;
    }

    try {
      const {stdout, stderr} = await execAsync(command, {
        cwd: this.workingDir,
        timeout: this.executeTimeoutMs,
      });

      const result: ExecuteResult = {status: 'ok'};
      if (stdout) {
        result.stdout = truncate(stdout, this.maxOutputChars);
      }
      if (stderr) {
        result.stderr = truncate(stderr, this.maxOutputChars);
      }
      return result;
    } catch (e) {
      // `promisify(exec)` rejects with an `ExecException`: an `Error` carrying
      // the child process's exit status and captured output.
      const err: ExecException = toError(e);
      const result: ExecuteResult = {status: 'error'};
      if (err.killed) {
        result.error = `Command timed out after ${
          this.executeTimeoutMs / 1000
        }s.`;
      } else {
        result.exit_code = err.code;
        result.error = err.message;
      }
      if (err.stdout) {
        result.stdout = truncate(err.stdout, this.maxOutputChars);
      }
      if (err.stderr) {
        result.stderr = truncate(err.stderr, this.maxOutputChars);
      }
      return result;
    }
  }

  /**
   * Requires an explicit client-side confirmation before a command runs, so
   * that a prompt injection cannot silently execute code on the host.
   *
   * @return An intermediate result when the call must pause for confirmation,
   *     an error result when the client rejected it, or `undefined` when the
   *     caller may proceed.
   */
  private enforceConfirmation(
    toolContext: Context,
    command: string,
  ): ExecuteToolResult | undefined {
    const confirmation = toolContext.toolConfirmation;

    if (!confirmation) {
      toolContext.requestConfirmation({
        hint:
          'Confirmation is required before running a shell command. The agent ' +
          `requested to run the following command in ${this.workingDir}. ` +
          'Only approve if you trust it:\n\n' +
          command,
        payload: {command, workingDir: this.workingDir},
      });
      return {partial: REQUIRE_CONFIRMATION_MESSAGE};
    }

    if (!confirmation.confirmed) {
      return {
        status: 'error',
        error: 'Command execution was not confirmed and was rejected.',
      };
    }

    return undefined;
  }
}
