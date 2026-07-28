/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Docker from 'dockerode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {PassThrough} from 'node:stream';
import {text} from 'node:stream/consumers';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
} from './code_execution_utils.js';

const DEFAULT_IMAGE_TAG = 'adk-code-executor:latest';

type DockerConstructor = new (options?: Docker.DockerOptions) => Docker;

/**
 * Lazily loads the `dockerode` constructor. It is imported dynamically (rather
 * than at the top of the module) so that importing `@google/adk` does not
 * eagerly pull in dockerode and its native transitive dependencies (`ssh2`);
 * the client is only loaded when an executor is actually used. This mirrors
 * adk-python's lazy `import docker` and the sibling DB-driver loading in
 * `sessions/db`.
 */
let dockerodeCtor: Promise<DockerConstructor> | undefined;
function loadDockerodeCtor(): Promise<DockerConstructor> {
  dockerodeCtor ??= import('dockerode').then((mod) => mod.default);
  return dockerodeCtor;
}

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

/**
 * How each supported language is executed inside the container: the interpreter
 * to probe for on startup, and the argv used to run a code string.
 *
 * TypeScript is run through `npx tsx`, which type-strips and executes in one
 * step, so no separate compile step or `tsconfig` is needed in the image.
 */
const RUNTIME_BY_LANGUAGE: Partial<
  Record<
    CodeExecutionLanguage,
    {probe: string; command: (code: string) => string[]}
  >
> = {
  [CodeExecutionLanguage.PYTHON]: {
    probe: 'python3',
    command: (code) => ['python3', '-c', code],
  },
  [CodeExecutionLanguage.JAVASCRIPT]: {
    probe: 'node',
    command: (code) => ['node', '-e', code],
  },
  [CodeExecutionLanguage.TYPESCRIPT]: {
    probe: 'npx',
    command: (code) => ['npx', '--yes', 'tsx', '--eval', code],
  },
  [CodeExecutionLanguage.SHELL]: {
    probe: 'sh',
    command: (code) => ['sh', '-c', code],
  },
};

/**
 * The Docker container backing a {@link ContainerCodeExecutor}, wrapping the
 * whole lifecycle (`build` -> `start` -> `execute` -> `stop`) behind one small
 * API so the executor itself only decides *what* to run, not *how* to drive
 * Docker.
 */
class DockerContainer {
  private container?: Docker.Container;

  constructor(
    private readonly client: Docker,
    private readonly image: string,
    private readonly networkEnabled: boolean,
  ) {}

  /** Builds the image from a directory containing a Dockerfile. */
  async build(dockerPath: string): Promise<void> {
    if (!fs.existsSync(dockerPath)) {
      throw new Error(`Invalid Docker path: ${dockerPath}`);
    }
    logger.debug('Building Docker image...');
    const stream = await this.client.buildImage(
      {context: dockerPath, src: fs.readdirSync(dockerPath)},
      {t: this.image},
    );
    await new Promise<void>((resolve, reject) => {
      this.client.modem.followProgress(stream, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    logger.debug(`Docker image ${this.image} built.`);
  }

  /** Creates and starts the container, registering it for exit cleanup. */
  async start(): Promise<void> {
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
  }

  /**
   * Runs a command inside the container and returns its decoded output. The
   * exec is created without a TTY so the stream stays multiplexed and can be
   * split into stdout and stderr via `modem.demuxStream`.
   */
  async execute(cmd: string[]): Promise<ExecOutput> {
    if (!this.container) {
      throw new Error('Container is not started.');
    }
    const exec = await this.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({hijack: true, stdin: false});

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.client.modem.demuxStream(stream, stdout, stderr);
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

  /** Stops and removes the container. Safe to call when never started. */
  async stop(): Promise<void> {
    const container = this.container;
    this.container = undefined;
    if (container) {
      activeContainers.delete(container);
    }
    await stopAndRemove(container);
  }
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
  private readonly baseUrl?: string;
  private readonly injectedClient?: Docker;
  private container?: DockerContainer;
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
    this.baseUrl = options.baseUrl;
    this.injectedClient = options.docker;
    // These invariants mirror Python's frozen fields: this executor is never
    // stateful and never optimizes data files.
    this.stateful = false;
    this.optimizeDataFile = false;
    registerExitHooks();
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {code, language} = params.codeExecutionInput;
    // Unlike adk-python (which always shells out to python3), dispatch on the
    // declared language so JS/TS and shell snippets run under the right
    // interpreter instead of being fed to Python and failing at parse time.
    const runtime = RUNTIME_BY_LANGUAGE[language];
    if (!runtime) {
      throw new Error(
        `Unsupported language for ContainerCodeExecutor: ${language}. ` +
          `Supported: ${Object.keys(RUNTIME_BY_LANGUAGE).join(', ')}.`,
      );
    }
    await this.ensureContainer();
    const {stdout, stderr} = await this.container!.execute(
      runtime.command(code),
    );
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
    const client = await this.resolveClient();
    const container = new DockerContainer(
      client,
      this.image,
      this.networkEnabled,
    );
    if (this.dockerPath) {
      await container.build(this.dockerPath);
    }
    await container.start();
    this.container = container;

    // Probe only python3: it is the baseline the default image guarantees, and
    // failing here would otherwise leave a started container behind. Other
    // languages are validated lazily by their own `which` probe on first use.
    const {exitCode} = await container.execute(['which', 'python3']);
    if (exitCode !== 0) {
      throw new Error('python3 is not installed in the container.');
    }
  }

  /** Resolves the Docker client, lazily loading dockerode when not injected. */
  private async resolveClient(): Promise<Docker> {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    const DockerClient = await loadDockerodeCtor();
    return new DockerClient(
      this.baseUrl ? parseBaseUrl(this.baseUrl) : undefined,
    );
  }
}
