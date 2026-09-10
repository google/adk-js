/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Docker from 'dockerode';
import * as path from 'node:path';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
} from './code_execution_utils.js';
import {
  DockerContainer,
  type DockerContainerOptions,
  TIMEOUT_EXIT_CODE,
} from './docker_container.js';

const DEFAULT_IMAGE_TAG = 'adk-code-executor:latest';

/**
 * Default wall-clock timeout, in seconds, for a single execution. Matches
 * adk-python's `ContainerCodeExecutor` default.
 */
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * coreutils prefix used to bound a run inside the shared container. It sends
 * SIGKILL after the deadline and exits {@link TIMEOUT_EXIT_CODE}.
 */
const TIMEOUT_COMMAND = ['timeout', '-s', 'KILL'];

/**
 * Options for {@link ContainerCodeExecutor}.
 */
export interface ContainerCodeExecutorOptions {
  /** Optional base url of a user-hosted Docker daemon (e.g. `tcp://host:2375`). */
  baseUrl?: string;
  /**
   * Tag of the predefined or custom image to run on the container. Either
   * `image` or `dockerPath` must be set. Defaults to `adk-code-executor:latest`
   * when only `dockerPath` is given.
   */
  image?: string;
  /**
   * Path to a directory containing a Dockerfile. If set, the image is built
   * from it instead of using a prebuilt tag. Either `image` or `dockerPath`
   * must be set.
   */
  dockerPath?: string;
  /**
   * Start the container with networking enabled. Defaults to false so
   * untrusted, model-generated code cannot reach the network (the cloud
   * metadata endpoint, internal services, or exfiltration destinations).
   */
  networkEnabled?: boolean;
  /**
   * Wall-clock timeout in seconds for a single execution. Must be greater than
   * 0; defaults to 300. Every execution shares one long-lived container, so an
   * unbounded run (e.g. a loop emitted by the model) would burn that
   * container's CPU for every later caller. Raise it rather than remove it for
   * a computation that legitimately runs longer.
   */
  timeoutSeconds?: number;
  /**
   * Injected Docker client, primarily for testing so unit tests never touch a
   * real Docker daemon. Defaults to a new client built from `baseUrl`.
   */
  docker?: Docker;
}

/**
 * The argv prefix used to run a code string for each supported language; the
 * code is appended as the final argument.
 *
 * Only Python is guaranteed by the default image, and the container has no
 * network access by default, so the interpreter for every other language
 * (`node`, `tsx`, `sh`) must already be installed in the image. TypeScript runs
 * through `tsx`, which type-strips and executes in one step but cannot be
 * fetched on demand, so the image must preinstall it.
 */
const LANGUAGE_RUNTIME_COMMAND_MAP: Partial<
  Record<CodeExecutionLanguage, string[]>
> = {
  [CodeExecutionLanguage.PYTHON]: ['python3', '-c'],
  [CodeExecutionLanguage.JAVASCRIPT]: ['node', '-e'],
  [CodeExecutionLanguage.TYPESCRIPT]: ['tsx', '--eval'],
  [CodeExecutionLanguage.SHELL]: ['sh', '-c'],
};

/**
 * A code executor that runs model-generated code inside a hardened Docker
 * container via the `dockerode` client.
 *
 * Security note: this executor runs model-generated code, which may be
 * influenced by untrusted input (e.g. via prompt injection). By default the
 * container is started with networking disabled and all Linux capabilities
 * dropped so the executed code cannot reach the network (including the cloud
 * metadata endpoint at `169.254.169.254`) or escalate privileges. Networking
 * can be re-enabled via `networkEnabled: true` when the executed code is
 * trusted.
 *
 * Limitations: this executor runs a code string only. `inputFiles` and `args`
 * on the request are not copied into the container, and output files are not
 * collected (`outputFiles` is always empty), so tools that stage resource
 * files or read artifacts back (e.g. `RunSkillScriptTool`) are not yet
 * supported. Sending files in and out via `putArchive`/`getArchive` is future
 * work.
 */
@experimental
export class ContainerCodeExecutor extends BaseCodeExecutor {
  private readonly dockerPath?: string;
  private readonly containerOptions: DockerContainerOptions;
  private readonly timeoutSeconds: number;
  private container?: DockerContainer;
  private initPromise?: Promise<void>;

  constructor(options: ContainerCodeExecutorOptions = {}) {
    super();
    if (!options.image && !options.dockerPath) {
      throw new Error(
        'Either image or dockerPath must be set for ContainerCodeExecutor.',
      );
    }
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (this.timeoutSeconds <= 0) {
      throw new Error(
        'timeoutSeconds must be greater than 0 for ContainerCodeExecutor.',
      );
    }
    this.dockerPath = options.dockerPath
      ? path.resolve(options.dockerPath)
      : undefined;
    this.containerOptions = {
      image: options.image ?? DEFAULT_IMAGE_TAG,
      networkEnabled: options.networkEnabled ?? false,
      baseUrl: options.baseUrl,
      docker: options.docker,
    };
    // Mirror Python's frozen fields: this executor is never stateful and never
    // optimizes data files, and neither can be flipped after construction.
    defineFrozenFalse(this, 'stateful');
    defineFrozenFalse(this, 'optimizeDataFile');
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {code, language} = params.codeExecutionInput;
    // Unlike adk-python (which always shells out to python3), dispatch on the
    // declared language so JS/TS and shell snippets run under the right
    // interpreter instead of being fed to Python and failing at parse time.
    const command = LANGUAGE_RUNTIME_COMMAND_MAP[language];
    if (!command) {
      throw new Error(
        `Unsupported language for ContainerCodeExecutor: ${language}. ` +
          `Supported: ${Object.keys(LANGUAGE_RUNTIME_COMMAND_MAP).join(', ')}.`,
      );
    }
    await this.ensureContainer();
    // Bound the run inside the shared container. A process that detaches from
    // it (e.g. via `setsid`) outlives the deadline until the container is torn
    // down; this covers the common wedge (a `while True` from the model).
    const {stdout, stderr, exitCode} = await this.container!.execute(
      [...TIMEOUT_COMMAND, String(this.timeoutSeconds), ...command, code],
      this.timeoutSeconds,
    );
    logger.debug(`Executed ${language} code:\n\`\`\`\n${code}\n\`\`\``);
    return {
      stdout,
      stderr: this.describeExit(stderr, exitCode),
      outputFiles: [],
    };
  }

  /**
   * Turns a non-zero exit into stderr the model can see. An empty stderr maps
   * to `OUTCOME_OK` downstream, so a program that exits non-zero without
   * writing stderr would otherwise look successful (matching
   * `UnsafeLocalCodeExecutor`).
   */
  private describeExit(stderr: string, exitCode: number | null): string {
    if (exitCode === TIMEOUT_EXIT_CODE) {
      const message = `Code execution timed out after ${this.timeoutSeconds} seconds.`;
      return stderr ? `${stderr}\n${message}` : message;
    }
    if (exitCode !== 0 && exitCode !== null && !stderr) {
      return `Exit code ${exitCode}`;
    }
    return stderr;
  }

  /**
   * Stops and removes the container. Safe to call when no container has been
   * started; provided for deterministic teardown in tests and app shutdown.
   */
  async close(): Promise<void> {
    const container = this.container;
    this.container = undefined;
    this.initPromise = undefined;
    await container?.stop();
  }

  /** Lazily builds/starts the container exactly once. */
  private ensureContainer(): Promise<void> {
    if (!this.initPromise) {
      // Clear the memoized promise on failure so a transient init error does
      // not poison the executor until close().
      this.initPromise = this.initContainer().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async initContainer(): Promise<void> {
    const container = new DockerContainer(this.containerOptions);
    if (this.dockerPath) {
      await container.build(this.dockerPath);
    }
    await container.start();
    this.container = container;

    // Probe python3 after start: it is the baseline the default image
    // guarantees, and assigning `this.container` first means a failure here
    // still leaves the container tracked so `close()` can clean it up.
    const {exitCode} = await container.execute(
      ['which', 'python3'],
      this.timeoutSeconds,
    );
    if (exitCode !== 0) {
      throw new Error('python3 is not installed in the container.');
    }
  }
}

/**
 * Defines a read-only `false` property, so a caller cannot flip it after
 * construction. Assigning to it throws in strict mode, matching Python's frozen
 * fields.
 */
function defineFrozenFalse(target: object, key: string): void {
  Object.defineProperty(target, key, {
    value: false,
    writable: false,
    enumerable: true,
    configurable: false,
  });
}
