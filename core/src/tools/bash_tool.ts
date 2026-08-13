/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {spawn} from 'node:child_process';
import * as path from 'node:path';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Configuration options for BashToolPolicy.
 */
export interface BashToolPolicyOptions {
  /**
   * Allowed command prefixes. Use `['*']` (default) to allow all commands,
   * or list specific prefixes (e.g. `['git', 'ls', 'cat']`).
   */
  allowedCommandPrefixes?: string[];

  /**
   * Blocked operators or substrings in commands (e.g. `['rm -rf', '>', '|']`).
   */
  blockedOperators?: string[];

  /**
   * Command execution timeout in seconds. Default is 30 seconds.
   */
  timeoutSeconds?: number;

  /**
   * Maximum memory in bytes for the process (optional policy metadata).
   */
  maxMemoryBytes?: number;

  /**
   * Maximum file size in bytes (optional policy metadata).
   */
  maxFileSizeBytes?: number;

  /**
   * Maximum child processes (optional policy metadata).
   */
  maxChildProcesses?: number;
}

/**
 * Configuration policy for allowed bash commands and resource limits.
 */
export class BashToolPolicy {
  readonly allowedCommandPrefixes: readonly string[];
  readonly blockedOperators: readonly string[];
  readonly timeoutSeconds: number;
  readonly maxMemoryBytes?: number;
  readonly maxFileSizeBytes?: number;
  readonly maxChildProcesses?: number;

  constructor(options: BashToolPolicyOptions = {}) {
    this.allowedCommandPrefixes = Object.freeze([
      ...(options.allowedCommandPrefixes ?? ['*']),
    ]);
    this.blockedOperators = Object.freeze([
      ...(options.blockedOperators ?? []),
    ]);
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.maxMemoryBytes = options.maxMemoryBytes;
    this.maxFileSizeBytes = options.maxFileSizeBytes;
    this.maxChildProcesses = options.maxChildProcesses;
  }
}

/**
 * Validates a bash command against the permitted prefixes and blocked operators.
 */
function validateCommand(
  command: string,
  policy: BashToolPolicy,
): string | undefined {
  const stripped = command.trim();
  if (!stripped) {
    return 'Command is required.';
  }

  for (const op of policy.blockedOperators) {
    if (command.includes(op)) {
      return `Command contains blocked operator: ${op}`;
    }
  }

  if (policy.allowedCommandPrefixes.includes('*')) {
    return undefined;
  }

  for (const prefix of policy.allowedCommandPrefixes) {
    if (stripped.startsWith(prefix)) {
      return undefined;
    }
  }

  const allowed = policy.allowedCommandPrefixes.join(', ');
  return `Command blocked. Permitted prefixes are: ${allowed}`;
}

/**
 * Options for configuring ExecuteBashTool.
 */
export interface ExecuteBashToolOptions {
  /**
   * Working directory for bash command execution. Defaults to `process.cwd()`.
   */
  workspace?: string;

  /**
   * Configuration policy for allowed commands, blocked operators, and timeouts.
   */
  policy?: BashToolPolicy | BashToolPolicyOptions;

  /**
   * Custom tool name. Defaults to `'execute_bash'`.
   */
  name?: string;

  /**
   * Custom description for the tool.
   */
  description?: string;

  /**
   * Whether this tool requires user confirmation before executing commands.
   * Defaults to true (matching Python ADK ExecuteBashTool).
   */
  requireConfirmation?: boolean;

  /**
   * Custom shell command path (e.g. `'bash'`, `'/bin/zsh'`, `'powershell'`).
   */
  shellCommandPath?: string;
}

/**
 * Result payload returned when bash command finishes successfully.
 */
export interface BashToolSuccessResult {
  stdout: string;
  stderr: string;
  returncode: number | null;
}

/**
 * Result payload returned when bash command fails or is rejected.
 */
export interface BashToolErrorResult {
  error: string;
  stdout?: string;
  stderr?: string;
  returncode?: number | null;
}

/**
 * Union result of bash execution.
 */
export type BashToolResult = BashToolSuccessResult | BashToolErrorResult;

const EXECUTE_BASH_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.executeBashTool',
);

/**
 * Tool to execute a validated bash command within a workspace directory.
 */
export class ExecuteBashTool extends BaseTool {
  readonly [EXECUTE_BASH_TOOL_SIGNATURE_SYMBOL] = true;

  private readonly workspace: string;
  private readonly policy: BashToolPolicy;
  private readonly requireConfirmation: boolean;
  private readonly shellCommandPath?: string;

  constructor(options: ExecuteBashToolOptions = {}) {
    const policy =
      options.policy instanceof BashToolPolicy
        ? options.policy
        : new BashToolPolicy(options.policy);

    const name = options.name ?? 'execute_bash';
    const allowedHint = policy.allowedCommandPrefixes.includes('*')
      ? 'any command'
      : `commands matching prefixes: ${policy.allowedCommandPrefixes.join(', ')}`;
    const description =
      options.description ??
      `Executes a bash command with the working directory set to the workspace. Allowed: ${allowedHint}. All commands require user confirmation.`;

    super({name, description});

    this.workspace = path.resolve(options.workspace ?? process.cwd());
    this.policy = policy;
    this.requireConfirmation = options.requireConfirmation ?? true;
    this.shellCommandPath = options.shellCommandPath;
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description: 'The bash command to execute.',
          },
        },
        required: ['command'],
      },
    };
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<BashToolResult> {
    const rawCommand = req.args?.command;
    const command = typeof rawCommand === 'string' ? rawCommand : '';

    if (!command || !command.trim()) {
      return {error: 'Command is required.'};
    }

    // Static validation against policy.
    const validationError = validateCommand(command, this.policy);
    if (validationError) {
      return {error: validationError};
    }

    // Check human-in-the-Loop confirmation if enabled.
    if (this.requireConfirmation) {
      const toolContext = req.toolContext;
      if (!toolContext?.toolConfirmation) {
        if (toolContext?.functionCallId) {
          toolContext.requestConfirmation({
            hint: `Please approve or reject the bash command: ${command}`,
          });
        }
        if (toolContext?.actions) {
          toolContext.actions.skipSummarization = true;
        }
        return {
          error:
            'This tool call requires confirmation, please approve or reject.',
        };
      }

      if (!toolContext.toolConfirmation.confirmed) {
        return {error: 'This tool call is rejected.'};
      }
    }

    // Execute subprocess.
    return this.executeProcess(command);
  }

  private executeProcess(command: string): Promise<BashToolResult> {
    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      const shell = this.shellCommandPath ?? (isWindows ? 'cmd.exe' : 'bash');
      const shellArgs = isWindows ? ['/D', '/c', command] : ['-c', command];

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(shell, shellArgs, {
          cwd: this.workspace,
          timeout: this.policy.timeoutSeconds * 1000,
          killSignal: 'SIGKILL',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve({
          error: `Execution failed: ${message}`,
          stdout: '<no stdout captured>',
          stderr: '<no stderr captured>',
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (this.policy.timeoutSeconds > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore process kill errors if already exited
          }
        }, this.policy.timeoutSeconds * 1000);
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          error: `Execution failed: ${err.message}`,
          stdout: stdout || '<no stdout captured>',
          stderr: stderr || '<no stderr captured>',
        });
      });

      child.on('close', (exitCode, signal) => {
        if (timer) clearTimeout(timer);

        if (timedOut || signal === 'SIGKILL' || signal === 'SIGTERM') {
          resolve({
            error: `Command timed out after ${this.policy.timeoutSeconds} seconds.`,
            stdout: stdout || '<no stdout captured>',
            stderr: stderr || '<no stderr captured>',
            returncode: exitCode,
          });
          return;
        }

        resolve({
          stdout: stdout || '<no stdout captured>',
          stderr: stderr || '<no stderr captured>',
          returncode: exitCode,
        });
      });
    });
  }

  /**
   * Telemetry hook: returns an error type if the response indicates an error.
   */
  _detectErrorInResponse(response: unknown): string | undefined {
    if (
      typeof response === 'object' &&
      response !== null &&
      'error' in response &&
      Boolean((response as {error?: unknown}).error)
    ) {
      return 'TOOL_ERROR';
    }
    return undefined;
  }
}

/**
 * Type guard to check if an object is an instance of ExecuteBashTool.
 */
export function isExecuteBashTool(obj: unknown): obj is ExecuteBashTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    EXECUTE_BASH_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[EXECUTE_BASH_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Alias of ExecuteBashTool for convenience.
 */
export {ExecuteBashTool as BashTool};
export const isBashTool = isExecuteBashTool;
