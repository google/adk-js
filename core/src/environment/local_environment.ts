/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {BaseEnvironment, ExecutionResult} from './base_environment.js';

/** Prefix for the temporary workspace created when no `workingDir` is given. */
const TEMP_WORKSPACE_PREFIX = 'adk_workspace_';

/** Options for {@link LocalEnvironment}. */
export interface LocalEnvironmentOptions {
  /**
   * Absolute path to the workspace directory. Created by
   * {@link LocalEnvironment.initialize} if it does not exist, and never deleted
   * by {@link LocalEnvironment.close}. If omitted, a temporary directory is
   * created on `initialize()` and removed on `close()`.
   */
  workingDir?: string;
  /** Extra variables merged over `process.env` for every executed command. */
  envVars?: Record<string, string>;
}

/**
 * Resolves `filePath` against `workingDir` and rejects anything outside it.
 *
 * This is a **lexical** containment check on the resolved path strings, not a
 * sandbox: it does not survive symlinks, hardlinks, bind mounts, or TOCTOU
 * races. It is a guard against accidental traversal, not a security boundary.
 *
 * @throws If the resolved path is not inside `workingDir`.
 */
function resolvePathInWorkingDir(workingDir: string, filePath: string): string {
  const base = path.resolve(workingDir);
  const resolved = path.resolve(base, filePath);
  const relative = path.relative(base, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    // `path.relative` returns an absolute path across Windows drives.
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes working directory: ${filePath}`);
  }
  return resolved;
}

/**
 * Executes commands via local child processes, scoped to a working directory.
 *
 * When `workingDir` is not specified, a temporary directory is created on
 * {@link initialize} and removed on {@link close}.
 *
 * WARNING: this class runs arbitrary shell strings on the host with **no
 * sandboxing** and no sanitisation — the caller is responsible for trusting the
 * command. It is a building block; tools built on top of it are responsible for
 * gating execution behind an explicit user confirmation.
 *
 * Further limitations, all shared with the adk-python reference implementation:
 * - stdout and stderr are buffered fully in memory with no cap, so a command
 *   producing unbounded output will grow the heap until it fails.
 * - The child inherits the whole of `process.env`, so any secret in the parent
 *   environment is visible to the command.
 * - A timeout sends `SIGKILL` to the spawned shell; processes it forked itself
 *   may survive, and anything they write after the kill is not captured. On
 *   Windows such a survivor also keeps the working directory locked, so a
 *   {@link close} following a timeout can fail to remove a temporary workspace.
 * - File paths are confined to the working directory by a lexical check only
 *   (see {@link readFile} and {@link writeFile}).
 */
@experimental
export class LocalEnvironment extends BaseEnvironment {
  private currentWorkingDir?: string;
  private readonly envVars?: Record<string, string>;
  private autoCreated = false;

  constructor(options: LocalEnvironmentOptions = {}) {
    super();
    this.currentWorkingDir = options.workingDir;
    this.envVars = options.envVars;
  }

  override get workingDir(): string {
    if (this.currentWorkingDir === undefined) {
      throw new Error('`workingDir` is not set. Call initialize() first.');
    }
    return this.currentWorkingDir;
  }

  override async initialize(): Promise<void> {
    if (this.currentWorkingDir === undefined) {
      this.currentWorkingDir = await fs.mkdtemp(
        path.join(os.tmpdir(), TEMP_WORKSPACE_PREFIX),
      );
      this.autoCreated = true;
      logger.debug(`Created temporary workspace: ${this.currentWorkingDir}`);
    } else {
      await fs.mkdir(this.currentWorkingDir, {recursive: true});
    }
    this.initialized = true;
  }

  override async close(): Promise<void> {
    if (this.autoCreated && this.currentWorkingDir !== undefined) {
      await fs.rm(this.currentWorkingDir, {recursive: true, force: true});
      logger.debug(`Removed temporary workspace: ${this.currentWorkingDir}`);
      this.currentWorkingDir = undefined;
    }
    this.initialized = false;
  }

  override async execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult> {
    this.assertInitialized();

    const child = spawn(command, {
      shell: true,
      cwd: this.workingDir,
      env: {...process.env, ...this.envVars},
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutSeconds !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        // Killing the shell does not kill a command it forked rather than
        // exec'd, and that survivor keeps the pipes open, which would hold
        // 'close' back until it exits on its own. Release the read ends so
        // the timeout is actually enforced.
        child.stdout.destroy();
        child.stderr.destroy();
      }, timeoutSeconds * 1000);
    }

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        // 'close' rather than 'exit': the stdio streams are drained by then.
        child.on('close', (code, signal) => {
          // Node reports either an exit code or the terminating signal; Python
          // reports the negative signal number (`-9` for SIGKILL), so map back.
          resolve(
            signal === null ? (code ?? 0) : -os.constants.signals[signal],
          );
        });
        child.on('error', reject);
      });
      return {
        exitCode,
        // Decode once, so a multi-byte character split across two chunks is
        // not corrupted. Invalid bytes become U+FFFD, matching Python's
        // `errors='replace'`.
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads a file from the working directory.
   *
   * `filePath` is confined to the working directory by a lexical check on the
   * resolved path, which is not a sandbox.
   *
   * @throws If the environment is not initialized, if the path escapes the
   *   working directory, or — as `ENOENT` — if the file does not exist.
   */
  override async readFile(filePath: string): Promise<Uint8Array> {
    this.assertInitialized();
    return fs.readFile(resolvePathInWorkingDir(this.workingDir, filePath));
  }

  /**
   * Writes a file in the working directory, creating parent directories.
   *
   * `filePath` is confined to the working directory by a lexical check on the
   * resolved path, which is not a sandbox. No newline translation is applied,
   * so explicit CRLF sequences are preserved.
   *
   * @throws If the environment is not initialized or the path escapes the
   *   working directory.
   */
  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.assertInitialized();
    const resolved = resolvePathInWorkingDir(this.workingDir, filePath);
    await fs.mkdir(path.dirname(resolved), {recursive: true});
    await fs.writeFile(resolved, content);
  }
}
