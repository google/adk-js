/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker from 'dockerode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {PassThrough} from 'node:stream';
import {text} from 'node:stream/consumers';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult} from './code_execution_utils.js';

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

/** Decoded output of a single command executed inside the container. */
interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Containers that must be cleaned up when the process exits. A single set with
 * one set of process hooks avoids leaking a listener per executor instance.
 */
const activeContainers = new Set<Docker.Container>();
let exitHooksRegistered = false;

/** Stops and removes a container, tolerating a missing container. */
async function stopAndRemove(container?: Docker.Container): Promise<void> {
  if (!container) {
    return;
  }
  await container.stop();
  await container.remove();
}

/** Best-effort cleanup of every tracked container on process exit. */
async function cleanupContainers(): Promise<void> {
  for (const container of activeContainers) {
    try {
      await stopAndRemove(container);
    } catch (error) {
      logger.error(`Failed to stop and remove container on exit: ${error}`);
    }
    activeContainers.delete(container);
  }
}

/**
 * Registers process-exit hooks once. Node cannot run async Docker cleanup on
 * the synchronous `'exit'` event, so `'beforeExit'` and termination signals are
 * used instead (the parity substitute for Python's `atexit`).
 */
function registerExitHooks(): void {
  if (exitHooksRegistered) {
    return;
  }
  exitHooksRegistered = true;
  process.once('beforeExit', cleanupContainers);
  process.once('SIGINT', cleanupContainers);
  process.once('SIGTERM', cleanupContainers);
}

const PROTOCOL_BY_SCHEME: Record<string, 'https' | 'http' | 'ssh'> = {
  'https:': 'https',
  'ssh:': 'ssh',
};

/** Maps a Docker daemon base url string to dockerode client options. */
function parseBaseUrl(baseUrl: string): Docker.DockerOptions {
  const url = new URL(baseUrl);
  if (url.protocol === 'unix:') {
    return {socketPath: url.pathname};
  }
  return {
    host: url.hostname,
    port: url.port || undefined,
    protocol: PROTOCOL_BY_SCHEME[url.protocol] ?? 'http',
  };
}

/** Builds a Docker image from a directory containing a Dockerfile. */
async function buildDockerImage(
  client: Docker,
  dockerPath: string,
  image: string,
): Promise<void> {
  if (!fs.existsSync(dockerPath)) {
    throw new Error(`Invalid Docker path: ${dockerPath}`);
  }
  logger.debug('Building Docker image...');
  const stream = await client.buildImage(
    {context: dockerPath, src: fs.readdirSync(dockerPath)},
    {t: image},
  );
  await new Promise<void>((resolve, reject) => {
    client.modem.followProgress(stream, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  logger.debug(`Docker image ${image} built.`);
}

/**
 * Runs a command inside the container and returns its decoded output. The exec
 * is created without a TTY so the stream stays multiplexed and can be split
 * into stdout and stderr via `modem.demuxStream`.
 */
async function runInContainer(
  container: Docker.Container,
  client: Docker,
  cmd: string[],
): Promise<ExecOutput> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({hijack: true, stdin: false});

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  client.modem.demuxStream(stream, stdout, stderr);
  const collected = Promise.all([text(stdout), text(stderr)]);

  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  stdout.end();
  stderr.end();

  const [stdoutText, stderrText] = await collected;
  const info = await exec.inspect();
  return {stdout: stdoutText, stderr: stderrText, exitCode: info.ExitCode};
}

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
  private readonly image: string;
  private readonly dockerPath?: string;
  private readonly networkEnabled: boolean;
  private readonly client: Docker;
  private container?: Docker.Container;
  private initPromise?: Promise<void>;

  constructor(options: ContainerCodeExecutorOptions = {}) {
    super();
    if (!options.image && !options.dockerPath) {
      throw new Error(
        'Either image or dockerPath must be set for ContainerCodeExecutor.',
      );
    }
    this.image = options.image ?? DEFAULT_IMAGE_TAG;
    this.dockerPath = options.dockerPath
      ? path.resolve(options.dockerPath)
      : undefined;
    this.networkEnabled = options.networkEnabled ?? false;
    // These invariants mirror Python's frozen fields: this executor is never
    // stateful and never optimizes data files.
    this.stateful = false;
    this.optimizeDataFile = false;
    this.client =
      options.docker ??
      new Docker(options.baseUrl ? parseBaseUrl(options.baseUrl) : undefined);
    registerExitHooks();
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    await this.ensureContainer();
    const {code} = params.codeExecutionInput;
    // Parity with Python: always run the code with python3 regardless of the
    // declared input language.
    const {stdout, stderr} = await runInContainer(
      this.container!,
      this.client,
      ['python3', '-c', code],
    );
    logger.debug(`Executed code:\n\`\`\`\n${code}\n\`\`\``);
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
    if (container) {
      activeContainers.delete(container);
    }
    await stopAndRemove(container);
  }

  /** Lazily builds/starts the container exactly once. */
  private ensureContainer(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initContainer();
    }
    return this.initPromise;
  }

  private async initContainer(): Promise<void> {
    if (this.dockerPath) {
      await buildDockerImage(this.client, this.dockerPath, this.image);
    }
    logger.debug('Starting container for ContainerCodeExecutor...');
    this.container = await this.client.createContainer({
      Image: this.image,
      Tty: true,
      NetworkDisabled: !this.networkEnabled,
      HostConfig: {CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges']},
    });
    await this.container.start();
    activeContainers.add(this.container);
    logger.debug(`Container ${this.container.id} started.`);

    const {exitCode} = await runInContainer(this.container, this.client, [
      'which',
      'python3',
    ]);
    if (exitCode !== 0) {
      throw new Error('python3 is not installed in the container.');
    }
  }
}
