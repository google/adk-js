/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Docker from 'dockerode';
import * as fs from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import {text} from 'node:stream/consumers';
import {setTimeout as delay} from 'node:timers/promises';
import {logger} from '../utils/logger.js';

type DockerConstructor = new (options?: Docker.DockerOptions) => Docker;

/**
 * Exit code reported when a run is killed for exceeding its deadline. Matches
 * the convention of coreutils `timeout(1)`, which the executor uses to bound a
 * run inside the container.
 */
export const TIMEOUT_EXIT_CODE = 124;

/** Extra time the stream wait is allowed beyond the in-container deadline. */
const STREAM_WAIT_GRACE_SECONDS = 5;

/** Bounds how long {@link DockerContainer.execute} polls for an exec to end. */
const MAX_INSPECT_ATTEMPTS = 50;
const INSPECT_POLL_MS = 100;

/**
 * Keeps the container alive so `exec` always has a running process to attach
 * to. Relying on the image's default CMD is not enough: an image whose CMD
 * exits leaves a dead container and every later exec fails with a 409.
 */
const KEEP_ALIVE_COMMAND = ['tail', '-f', '/dev/null'];

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
  dockerodeCtor ??= import('dockerode').then(
    (mod) => mod.default,
    () => {
      // dockerode is an optional dependency, so it may be absent.
      throw new Error(
        'The `dockerode` package is required to use ContainerCodeExecutor. ' +
          'Install it with `npm install dockerode`.',
      );
    },
  );
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

/**
 * Stops and removes a container. Returns whether the container is gone, so the
 * caller only drops its handle after removal actually succeeds. `stop()` on an
 * already-exited container reports HTTP 304, which is not fatal because the
 * forced remove below still deletes it.
 */
async function stopAndRemove(container?: Docker.Container): Promise<boolean> {
  if (!container) {
    return true;
  }
  try {
    await container.stop();
  } catch (error) {
    logger.debug(`Container ${container.id} was not running: ${error}`);
  }
  try {
    await container.remove({force: true});
    return true;
  } catch (error) {
    logger.error(`Failed to remove container ${container.id}: ${error}`);
    return false;
  }
}

/**
 * Best-effort cleanup of every tracked container on process exit. A container
 * is untracked only after it is actually removed, so a failed removal is
 * retried on the next exit hook rather than leaked.
 */
async function cleanupContainers(): Promise<void> {
  for (const container of activeContainers) {
    if (await stopAndRemove(container)) {
      activeContainers.delete(container);
    }
  }
}

/**
 * Cleans up on a termination signal, then re-raises it so Node runs its default
 * termination. Without the re-raise, registering the listener suppresses the
 * default action, so the first Ctrl-C would clean up and leave the process
 * alive. The `once` listener has already removed itself, so the re-raised
 * signal terminates the process.
 */
async function handleTerminationSignal(
  signal: 'SIGINT' | 'SIGTERM',
): Promise<void> {
  await cleanupContainers();
  process.kill(process.pid, signal);
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
  process.once('SIGINT', handleTerminationSignal);
  process.once('SIGTERM', handleTerminationSignal);
}

const PROTOCOL_BY_SCHEME: Record<string, 'https' | 'http' | 'ssh'> = {
  'https:': 'https',
  'ssh:': 'ssh',
};

/**
 * Reads the exit code once the exec has actually finished. Immediately after
 * the stream ends `inspect()` can still report `Running: true` with a null
 * `ExitCode`, which a caller would misread as a failed command (e.g. the
 * `which python3` probe), so this polls until the exec is no longer running.
 */
async function inspectExitCode(exec: Docker.Exec): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_INSPECT_ATTEMPTS; attempt++) {
    const info = await exec.inspect();
    if (!info.Running) {
      return info.ExitCode;
    }
    await delay(INSPECT_POLL_MS);
  }
  return (await exec.inspect()).ExitCode;
}

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

  /**
   * Builds the image from a directory containing a Dockerfile. `src` is the raw
   * directory listing; unlike the Docker CLI this does not honor
   * `.dockerignore`.
   */
  async build(dockerPath: string): Promise<void> {
    try {
      await fs.access(dockerPath);
    } catch {
      throw new Error(`Invalid Docker path: ${dockerPath}`);
    }
    const client = await this.getClient();
    logger.debug('Building Docker image...');
    const stream = await client.buildImage(
      {context: dockerPath, src: await fs.readdir(dockerPath)},
      {t: this.options.image},
    );
    await new Promise<void>((resolve, reject) => {
      client.modem.followProgress(stream, (error: Error | null) =>
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
      Cmd: KEEP_ALIVE_COMMAND,
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
   *
   * `timeoutSeconds` bounds the wait, not the in-container run: a process that
   * keeps the exec's stdio open (e.g. a surviving background child) means
   * `'end'` never fires, so without this cap the promise never settles (the
   * same hang #793 fixed in the local executor). Callers that need to bound the
   * run itself must wrap the command (see {@link ContainerCodeExecutor}). On a
   * cap breach the result carries {@link TIMEOUT_EXIT_CODE}.
   */
  async execute(cmd: string[], timeoutSeconds: number): Promise<ExecOutput> {
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

    let timedOut = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          timedOut = true;
          stream.destroy();
          resolve();
        },
        (timeoutSeconds + STREAM_WAIT_GRACE_SECONDS) * 1000,
      );
      timer.unref();
      stream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    stdout.end();
    stderr.end();

    const [stdoutText, stderrText] = await collected;
    if (timedOut) {
      return {
        stdout: stdoutText,
        stderr: stderrText,
        exitCode: TIMEOUT_EXIT_CODE,
      };
    }
    const exitCode = await inspectExitCode(exec);
    return {stdout: stdoutText, stderr: stderrText, exitCode};
  }

  /** Stops and removes the container. Safe to call when never started. */
  async stop(): Promise<void> {
    const container = this.container;
    if (!container) {
      return;
    }
    // Untrack only after removal succeeds. Dropping the handle first would
    // orphan a container whose removal rejects: it would keep running with no
    // handle left and the exit hook would never retry it.
    if (await stopAndRemove(container)) {
      this.container = undefined;
      activeContainers.delete(container);
    }
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
