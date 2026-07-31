/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Docker from 'dockerode';
import * as fs from 'node:fs';
import {PassThrough} from 'node:stream';
import {text} from 'node:stream/consumers';
import {logger} from '../utils/logger.js';

type DockerConstructor = new (options?: Docker.DockerOptions) => Docker;

/**
 * Lazily loads the `dockerode` constructor. It is imported dynamically (rather
 * than at the top of the module) so that importing `@google/adk` does not
 * eagerly pull in dockerode and its native transitive dependencies (`ssh2`);
 * the client is only loaded when a container is actually used. This mirrors
 * adk-python's lazy `import docker` and the sibling DB-driver loading in
 * `sessions/db`.
 */
let dockerodeCtor: Promise<DockerConstructor> | undefined;
function loadDockerodeCtor(): Promise<DockerConstructor> {
  dockerodeCtor ??= import('dockerode').then((mod) => mod.default);
  return dockerodeCtor;
}

/** Decoded output of a single command executed inside the container. */
export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Containers that must be cleaned up when the process exits. A single set with
 * one set of process hooks avoids leaking a listener per container instance.
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

/** Options for {@link DockerContainer}. */
export interface DockerContainerOptions {
  /** Tag of the predefined or custom image to run on the container. */
  image: string;
  /**
   * Start the container with networking enabled. When false, the container
   * cannot reach the network, which is the safe default for untrusted code.
   */
  networkEnabled: boolean;
  /** Optional base url of a user-hosted Docker daemon. */
  baseUrl?: string;
  /**
   * Injected Docker client. When omitted, dockerode is loaded lazily and a
   * client is built from `baseUrl`.
   */
  docker?: Docker;
}

/**
 * The Docker container backing a code executor, wrapping the whole lifecycle
 * (`build` -> `start` -> `execute` -> `stop`) and the Docker client resolution
 * behind one small API, so callers only decide *what* to run, not *how* to
 * drive Docker.
 */
export class DockerContainer {
  private client?: Docker;
  private container?: Docker.Container;

  constructor(private readonly options: DockerContainerOptions) {}

  /** Builds the image from a directory containing a Dockerfile. */
  async build(dockerPath: string): Promise<void> {
    if (!fs.existsSync(dockerPath)) {
      throw new Error(`Invalid Docker path: ${dockerPath}`);
    }
    const client = await this.getClient();
    logger.debug('Building Docker image...');
    const stream = await client.buildImage(
      {context: dockerPath, src: fs.readdirSync(dockerPath)},
      {t: this.options.image},
    );
    await new Promise<void>((resolve, reject) => {
      client.modem.followProgress(stream, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    logger.debug(`Docker image ${this.options.image} built.`);
  }

  /**
   * Creates and starts the container, registering it for cleanup on process
   * exit. Throws if already started: overwriting the handle would orphan the
   * running container. Call {@link stop} first.
   */
  async start(): Promise<void> {
    if (this.container) {
      throw new Error('Container is already started.');
    }
    const client = await this.getClient();
    logger.debug('Starting container...');
    this.container = await client.createContainer({
      Image: this.options.image,
      Tty: true,
      NetworkDisabled: !this.options.networkEnabled,
      HostConfig: {CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges']},
    });
    await this.container.start();
    activeContainers.add(this.container);
    registerExitHooks();
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
    const client = await this.getClient();
    const exec = await this.container.exec({
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

  /** Stops and removes the container. Safe to call when never started. */
  async stop(): Promise<void> {
    const container = this.container;
    this.container = undefined;
    if (container) {
      activeContainers.delete(container);
    }
    await stopAndRemove(container);
  }

  /**
   * Resolves the Docker client once, lazily loading dockerode when no client
   * was injected.
   */
  private async getClient(): Promise<Docker> {
    this.client ??=
      this.options.docker ??
      new (await loadDockerodeCtor())(
        this.options.baseUrl ? parseBaseUrl(this.options.baseUrl) : undefined,
      );
    return this.client;
  }
}
