/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {ChildProcess, spawn} from 'node:child_process';
import * as path from 'node:path';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Configuration options for BashToolPolicy.
 */
export interface BashToolPolicyOptions {
  /**
   * Allowed command prefixes. Use `['*']` (default) to allow all commands,
   * or list specific prefixes (e.g. `['git', 'ls', 'cat']`).
   *
   * Because commands are executed without a shell, a prefix constrains the
   * program that actually runs: with `['git']` the only binary this tool can
   * exec is `git`.
   */
  allowedCommandPrefixes?: string[];

  /**
   * Blocked operators or substrings in commands (e.g. `['rm -rf', '>', '|']`).
   *
   * This is a plain substring match and is defence in depth, not a security
   * boundary: `rm  -rf` (two spaces) and `rm -fr` do not match `rm -rf`. Use
   * {@link BashToolPolicyOptions.allowedCommandPrefixes} to constrain what can
   * run.
   */
  blockedOperators?: string[];

  /**
   * Command execution timeout in seconds. Default is 30 seconds. Values of 0
   * or less disable the timeout.
   */
  timeoutSeconds?: number;
}

const BASH_TOOL_POLICY_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.bashToolPolicy',
);

/**
 * Configuration policy for allowed bash commands.
 *
 * Note that adk-python's `BashToolPolicy` additionally carries
 * `max_memory_bytes`, `max_file_size_bytes` and `max_child_processes`, which it
 * enforces with `setrlimit` in a `preexec_fn`. Node exposes no `setrlimit`
 * binding, so those fields are deliberately absent here rather than present and
 * inert.
 */
export class BashToolPolicy {
  /** A unique symbol to identify ADK bash tool policies. */
  readonly [BASH_TOOL_POLICY_SIGNATURE_SYMBOL] = true;

  readonly allowedCommandPrefixes: readonly string[];
  readonly blockedOperators: readonly string[];
  readonly timeoutSeconds: number;

  constructor(options: BashToolPolicyOptions = {}) {
    this.allowedCommandPrefixes = Object.freeze([
      ...(options.allowedCommandPrefixes ?? ['*']),
    ]);
    this.blockedOperators = Object.freeze([
      ...(options.blockedOperators ?? []),
    ]);
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
  }
}

/**
 * Type guard to check if an object is an instance of BashToolPolicy.
 */
export function isBashToolPolicy(obj: unknown): obj is BashToolPolicy {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASH_TOOL_POLICY_SIGNATURE_SYMBOL in obj &&
    obj[BASH_TOOL_POLICY_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Validates a bash command against the permitted prefixes and blocked
 * operators.
 */
function validateCommand(
  command: string,
  policy: BashToolPolicy,
): string | undefined {
  const stripped = command.trim();
  if (!stripped) {
    return 'Command is required.';
  }

  // Matches upstream: blocked operators are checked against the raw command
  // while prefixes are checked against the stripped one.
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

const TOKENIZER_WHITESPACE = new Set([' ', '\t', '\r', '\n']);

/**
 * Splits a command string into an argument vector using POSIX shell word
 * rules, equivalent to Python's `shlex.split(command)`.
 *
 * Only quoting and escaping are honoured. There is no expansion of variables,
 * globs, command substitutions or tildes, and no operator handling: `;`, `|`,
 * `&&`, `>` and newlines are ordinary characters that end up as literal
 * arguments. That is what makes
 * {@link BashToolPolicyOptions.allowedCommandPrefixes} meaningful — the vector
 * is exec'd directly, so only `argv[0]` ever runs.
 *
 * @throws Error if the command ends inside a quote or a trailing escape, using
 *   the same messages `shlex` raises.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    if (char === '\\') {
      const next = command[i + 1];
      if (next === undefined) {
        throw new Error('No escaped character');
      }
      // Outside quotes a backslash escapes any single character.
      current += next;
      hasToken = true;
      i += 2;
      continue;
    }

    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        throw new Error('No closing quotation');
      }
      // Single quotes are fully literal, including backslashes.
      current += command.slice(i + 1, end);
      hasToken = true;
      i = end + 1;
      continue;
    }

    if (char === '"') {
      i++;
      let closed = false;
      while (i < command.length) {
        const inner = command[i];
        if (inner === '\\') {
          const next = command[i + 1];
          if (next === undefined) {
            throw new Error('No escaped character');
          }
          // Inside double quotes a backslash only escapes `"` and `\`;
          // anything else keeps the backslash, as in `shlex` posix mode.
          current += next === '"' || next === '\\' ? next : `\\${next}`;
          i += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          i++;
          break;
        }
        current += inner;
        i++;
      }
      if (!closed) {
        throw new Error('No closing quotation');
      }
      hasToken = true;
      continue;
    }

    if (TOKENIZER_WHITESPACE.has(char)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      i++;
      continue;
    }

    current += char;
    hasToken = true;
    i++;
  }

  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Kills the subprocess group, so a timeout also reaches anything the command
 * spawned. Equivalent to upstream's `os.killpg(process.pid, SIGKILL)`.
 */
function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    // A negative pid signals the whole process group.
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone, or the platform refused; fall back to the
    // direct child.
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited.
    }
  }
}

/**
 * Options for configuring ExecuteBashTool.
 */
export interface ExecuteBashToolOptions {
  /**
   * Working directory for command execution. Defaults to `process.cwd()`.
   *
   * This sets the child's `cwd`; it is not a sandbox. A command is still free
   * to reach any path the calling user can reach by naming it absolutely.
   */
  workspace?: string;

  /**
   * Configuration policy for allowed commands, blocked operators, and
   * timeouts.
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
   *
   * WARNING: setting this to `false` removes the only human gate in front of
   * model-authored command execution, and has no counterpart in adk-python,
   * where confirmation is unconditional. Turn it off only when the policy alone
   * makes the tool safe for the deployment.
   */
  requireConfirmation?: boolean;
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
 * Tool to execute a validated command within a workspace directory.
 *
 * The command string is split into an argument vector with POSIX word rules
 * and exec'd directly — no shell is involved, matching adk-python's
 * `shlex.split` + `create_subprocess_exec`. Shell operators are therefore
 * inert: `git status; rm -rf /` tries to exec `git` with the literal arguments
 * `status;`, `rm`, `-rf`, `/` and fails harmlessly. Pipes, redirection, globs
 * and variable expansion are not available.
 *
 * Known limits, all shared with or inherited from upstream:
 *
 * - POSIX only. Like adk-python, this tool refuses to run on Windows rather
 *   than apply POSIX-shaped rules to `cmd.exe`.
 * - No resource limits. Upstream caps memory, file size and child processes
 *   with `setrlimit`; Node exposes no equivalent, so those knobs are absent
 *   from {@link BashToolPolicy}.
 * - `workspace` is the child's working directory, not a jail.
 */
export class ExecuteBashTool extends BaseTool {
  readonly [EXECUTE_BASH_TOOL_SIGNATURE_SYMBOL] = true;

  private readonly workspace: string;
  private readonly policy: BashToolPolicy;
  private readonly requireConfirmation: boolean;

  constructor(options: ExecuteBashToolOptions = {}) {
    const policy = isBashToolPolicy(options.policy)
      ? options.policy
      : new BashToolPolicy(options.policy);

    const name = options.name ?? 'execute_bash';
    const requireConfirmation = options.requireConfirmation ?? true;
    const allowedHint = policy.allowedCommandPrefixes.includes('*')
      ? 'any command'
      : `commands matching prefixes: ${policy.allowedCommandPrefixes.join(', ')}`;
    const confirmationHint = requireConfirmation
      ? ' All commands require user confirmation.'
      : '';
    const description =
      options.description ??
      `Executes a command with the working directory set to the workspace. ` +
        `The command is split into an argument vector and executed directly ` +
        `without a shell, so pipes, redirection, globs, variable expansion ` +
        `and command separators such as |, >, ; and && are not interpreted ` +
        `and are passed through as literal arguments. ` +
        `Allowed: ${allowedHint}.${confirmationHint}`;

    super({name, description});

    this.workspace = path.resolve(options.workspace ?? process.cwd());
    this.policy = policy;
    this.requireConfirmation = requireConfirmation;
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
            description: 'The command to execute.',
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

    // Check human-in-the-loop confirmation if enabled.
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

    // Upstream refuses non-POSIX platforms outright rather than reason about
    // a second shell's syntax; the check sits after confirmation there too.
    if (process.platform === 'win32') {
      return {error: 'ExecuteBashTool is only supported on POSIX systems.'};
    }

    let argv: string[];
    try {
      argv = tokenizeCommand(command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        error: `Execution failed: ${message}`,
        stdout: '<no stdout captured>',
        stderr: '<no stderr captured>',
      };
    }

    if (argv.length === 0 || !argv[0]) {
      return {error: 'Command is required.'};
    }

    // Execute subprocess.
    return this.executeProcess(argv);
  }

  private executeProcess(argv: string[]): Promise<BashToolResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: this.workspace,
          // Its own process group, so a timeout can signal the whole tree.
          // Equivalent to upstream's `start_new_session=True`.
          detached: true,
          // The command never inherits the agent's stdin: anything that reads
          // it sees EOF instead of blocking until the timeout.
          stdio: ['ignore', 'pipe', 'pipe'],
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
      let settled = false;

      const settle = (result: BashToolResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (this.policy.timeoutSeconds > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child);
        }, this.policy.timeoutSeconds * 1000);
      }

      // Upstream kills the group in a `finally` as well, so a command that
      // exits normally cannot leave a stray group behind. Doing it on `exit`
      // also releases any pipe a lingering grandchild still holds, which is
      // what lets `close` fire.
      child.on('exit', () => {
        killProcessGroup(child);
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        settle({
          error: `Execution failed: ${err.message}`,
          stdout: stdout || '<no stdout captured>',
          stderr: stderr || '<no stderr captured>',
        });
      });

      child.on('close', (exitCode) => {
        if (timer) clearTimeout(timer);

        if (timedOut) {
          settle({
            error: `Command timed out after ${this.policy.timeoutSeconds} seconds.`,
            stdout: stdout || '<no stdout captured>',
            stderr: stderr || '<no stderr captured>',
            returncode: exitCode,
          });
          return;
        }

        settle({
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
