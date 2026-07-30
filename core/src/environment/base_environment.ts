/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../utils/experimental.js';

/**
 * Result of a shell command executed in a {@link BaseEnvironment}.
 *
 * This is distinct from `CodeExecutionResult`, which is produced by the code
 * executors: a code executor runs a code *snippet* and reports the files it
 * produced, whereas an environment runs a *shell command* inside a working
 * directory and reports its process exit status.
 *
 * A command that succeeds with no output yields
 * `{exitCode: 0, stdout: '', stderr: '', timedOut: false}`.
 */
export interface ExecutionResult {
  /** The exit code of the process. `0` on success. */
  exitCode: number;
  /** Standard output captured from the process. `''` when nothing was written. */
  stdout: string;
  /** Standard error captured from the process. `''` when nothing was written. */
  stderr: string;
  /** Whether the execution exceeded the timeout. `false` when it completed. */
  timedOut: boolean;
}

/**
 * Abstract base class for code execution environments.
 *
 * An environment provides the ability to execute shell commands, read files,
 * and write files within a working directory. Concrete implementations include
 * local subprocess execution, sandboxed execution, container environments, and
 * cloud-hosted environments.
 *
 * Lifecycle:
 * 1. Construct the environment.
 * 2. Call {@link initialize} before first use.
 * 3. Use {@link execute}, {@link readFile}, {@link writeFile}.
 * 4. Call {@link close} when done.
 */
@experimental
export abstract class BaseEnvironment {
  /**
   * Backing flag for {@link isInitialized}.
   *
   * Subclasses own this flag: set it in {@link initialize} and clear it in
   * {@link close}.
   */
  protected initialized = false;

  /** Whether the environment has been initialized. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Initializes the environment (e.g. creates the working directory).
   *
   * Called before first use. The default implementation is a no-op and leaves
   * {@link isInitialized} `false`. Subclasses must be idempotent and must set
   * {@link initialized}.
   */
  async initialize(): Promise<void> {}

  /**
   * Releases resources held by the environment.
   *
   * The default implementation is a no-op. Subclasses must be idempotent and
   * must clear {@link initialized}.
   */
  async close(): Promise<void> {}

  /** The absolute path to the environment's working directory. */
  abstract get workingDir(): string;

  /**
   * Executes a shell command in the working directory.
   *
   * @param command The shell command string to execute.
   * @param timeoutSeconds Maximum execution time in seconds. `undefined` means
   *   no limit.
   * @returns The exit code, stdout, stderr, and timeout status. A non-zero exit
   *   code is reported in the result, not thrown.
   */
  abstract execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult>;

  /**
   * Reads a file from the environment's filesystem.
   *
   * @param filePath Absolute or working-dir-relative path to the file.
   * @returns The raw file contents.
   */
  abstract readFile(filePath: string): Promise<Uint8Array>;

  /**
   * Writes content to a file in the environment's filesystem.
   *
   * Parent directories are created automatically if they do not exist.
   *
   * @param filePath Absolute or working-dir-relative path to the file.
   * @param content The string or raw bytes to write.
   */
  abstract writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void>;

  /**
   * Throws if {@link initialize} has not been called.
   *
   * Implementations should call this at the start of every operation that needs
   * a live working directory.
   */
  protected assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'Environment is not initialized. Call initialize() first.',
      );
    }
  }
}
