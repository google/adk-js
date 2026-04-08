/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'child_process';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult} from './code_execution_utils.js';

/**
 * Options for UnsafeLocalCodeExecutor.
 */
export interface UnsafeLocalCodeExecutorOptions {
  /**
   * Timeout for code execution in seconds. Default is 30.
   */
  timeoutSeconds?: number;
  /**
   * The command to run the code. Default is `process.execPath` (Node.js).
   */
  commandPath?: string;
}

/**
 * A code executor that unsafely executes code in the local context.
 * By default, it executes JavaScript code using the current Node.js executable.
 */
export class UnsafeLocalCodeExecutor extends BaseCodeExecutor {
  private readonly timeoutSeconds: number;
  private readonly commandPath: string;

  constructor(options: UnsafeLocalCodeExecutorOptions = {}) {
    super();
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.commandPath = options.commandPath ?? process.execPath;
    this.stateful = false;
    this.optimizeDataFile = false;
  }

  executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    const {code} = params.codeExecutionInput;

    return new Promise((resolve) => {
      const child = spawn(this.commandPath, [], {
        timeout: this.timeoutSeconds * 1000,
        killSignal: 'SIGKILL',
        stdio: 'inherit',
      });

      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      child.on('error', (err) => {
        stderr += `Process error: ${err.message}\n`;
      });

      child.on('close', (exitCode, signal) => {
        if (signal === 'SIGKILL' || signal === 'SIGTERM') {
          stderr += `\nCode execution timed out after ${this.timeoutSeconds} seconds.`;
        }
        resolve({
          stdout,
          stderr,
          outputFiles: [],
        });
      });

      if (child.stdin) {
        child.stdin.write(code);
        child.stdin.end();
      } else {
        resolve({
          stdout: '',
          stderr: 'Could not open stdin for child process.',
          outputFiles: [],
        });
      }
    });
  }
}
