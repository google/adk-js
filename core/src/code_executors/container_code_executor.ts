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
} from './docker_container.js';

const DEFAULT_IMAGE_TAG = 'adk-code-executor:latest';

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
   * Injected Docker client, primarily for testing so unit tests never touch a
   * real Docker daemon. Defaults to a new client built from `baseUrl`.
   */
  docker?: Docker;
}

/**
 * The argv prefix used to run a code string for each supported language; the
 * code is appended as the final argument.
 *
 * TypeScript is run through `npx tsx`, which type-strips and executes in one
 * step, so no separate compile step or `tsconfig` is needed in the image.
 */
const LANGUAGE_RUNTIME_COMMAND_MAP: Partial<
  Record<CodeExecutionLanguage, string[]>
> = {
  [CodeExecutionLanguage.PYTHON]: ['python3', '-c'],
  [CodeExecutionLanguage.JAVASCRIPT]: ['node', '-e'],
  [CodeExecutionLanguage.TYPESCRIPT]: ['npx', '--yes', 'tsx', '--eval'],
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
 */
@experimental
export class ContainerCodeExecutor extends BaseCodeExecutor {
  private readonly dockerPath?: string;
  private readonly containerOptions: DockerContainerOptions;
  private container?: DockerContainer;
  private initPromise?: Promise<void>;

  constructor(options: ContainerCodeExecutorOptions = {}) {
    super();
    if (!options.image && !options.dockerPath) {
      throw new Error(
        'Either image or dockerPath must be set for ContainerCodeExecutor.',
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
    // These invariants mirror Python's frozen fields: this executor is never
    // stateful and never optimizes data files.
    this.stateful = false;
    this.optimizeDataFile = false;
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
    const {stdout, stderr} = await this.container!.execute([...command, code]);
    logger.debug(`Executed ${language} code:\n\`\`\`\n${code}\n\`\`\``);
    return {stdout, stderr, outputFiles: []};
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
      this.initPromise = this.initContainer();
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
    const {exitCode} = await container.execute(['which', 'python3']);
    if (exitCode !== 0) {
      throw new Error('python3 is not installed in the container.');
    }
  }
}
