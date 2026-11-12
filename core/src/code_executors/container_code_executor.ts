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
 * coreutils prefix used to bound a run inside the session container. It sends
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
   * 0; defaults to 300. Each session runs in its own long-lived container, so
   * an unbounded run (e.g. a loop emitted by the model) would burn that
   * container's CPU for every later call in the same session. Raise it rather
   * than remove it for a computation that legitimately runs longer.
   */
  timeoutSeconds?: number;
  /**
   * Maximum number of session containers to keep running concurrently.
   * When exceeded, the least recently used idle session container is stopped
   * and evicted. A container that is running code is never evicted, so the
   * count can exceed the limit until that run ends. Must be a positive
   * integer.
   */
  maxContainers?: number;
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
 * A separate container is started per session (keyed on `appName`, `userId`,
 * and `session.id` from `ExecuteCodeParams.invocationContext`) rather than
 * one container shared across every call: `codeExecutor` is a single
 * property set once on an `LlmAgent` instance, and that instance is the
 * long-lived object serving every session the agent handles, so a single
 * shared container would let one session's files, environment, and
 * background processes persist into a later, unrelated session's execution.
 * A container is still reused across multiple calls *within* the same
 * session, so the per-call container-startup cost is paid once per session,
 * not once per call. Set `maxContainers` to bound how many session containers
 * run at once; beyond it, the least recently used idle one is stopped.
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
  private readonly maxContainers?: number;
  /** Started session containers, ordered from least to most recently used. */
  private readonly containers = new Map<string, DockerContainer>();
  /** Container starts that are still in flight, keyed by session. */
  private readonly initPromises = new Map<string, Promise<DockerContainer>>();
  /**
   * Number of `executeCode` calls in progress per session. A session with a
   * call in progress is never evicted, so a run is not stopped midway.
   */
  private readonly activeExecutions = new Map<string, number>();
  /** Shared image build, so the image is built at most once per executor. */
  private buildPromise?: Promise<void>;
  private closing = false;
  private closePromise?: Promise<void>;

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
    this.maxContainers = options.maxContainers;
    if (
      this.maxContainers !== undefined &&
      (!Number.isInteger(this.maxContainers) || this.maxContainers < 1)
    ) {
      throw new Error(
        'maxContainers must be a positive integer for ContainerCodeExecutor.',
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
    const key = sessionKey(params.invocationContext);
    // Count the call before the container is resolved, so no eviction can
    // stop this session's container between its start and the run.
    this.activeExecutions.set(key, (this.activeExecutions.get(key) ?? 0) + 1);
    try {
      const container = await this.ensureContainer(key);
      // Bound the run inside the session's container. A process that detaches
      // from it (e.g. via `setsid`) outlives the deadline until the container
      // is torn down; this covers the common wedge (a `while True` from the
      // model).
      const {stdout, stderr, exitCode} = await container.execute(
        [...TIMEOUT_COMMAND, String(this.timeoutSeconds), ...command, code],
        this.timeoutSeconds,
      );
      logger.debug(`Executed ${language} code:\n\`\`\`\n${code}\n\`\`\``);
      return {
        stdout,
        stderr: this.describeExit(stderr, exitCode),
        outputFiles: [],
      };
    } finally {
      const remaining = (this.activeExecutions.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.activeExecutions.set(key, remaining);
      } else {
        this.activeExecutions.delete(key);
      }
      // Trim any overshoot that the run held back.
      this.evictLeastRecentlyUsed();
    }
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
   * Stops and removes every session's container. Waits for container starts
   * that are still in flight, so no container is left running after it
   * resolves. Safe to call when none has been started, and concurrent calls
   * share one teardown. Provided for deterministic teardown in tests and app
   * shutdown.
   */
  close(): Promise<void> {
    this.closePromise ??= this.stopAll().finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }

  private async stopAll(): Promise<void> {
    this.closing = true;
    try {
      // Loop so a start that begins while an earlier one settles is also
      // awaited; each such start sees `closing` and stops its own container.
      while (this.initPromises.size > 0) {
        await Promise.allSettled([...this.initPromises.values()]);
      }
      const containers = [...this.containers.values()];
      this.containers.clear();
      this.initPromises.clear();
      await Promise.allSettled(containers.map((container) => container.stop()));
    } finally {
      this.closing = false;
    }
  }

  /**
   * Returns the given session's container, starting it if needed. Concurrent
   * calls for one session share a single in-flight start, and reuse marks the
   * container as the most recently used.
   */
  private ensureContainer(key: string): Promise<DockerContainer> {
    const existing = this.containers.get(key);
    if (existing) {
      this.containers.delete(key);
      this.containers.set(key, existing);
      return Promise.resolve(existing);
    }
    const inFlight = this.initPromises.get(key);
    if (inFlight) {
      return inFlight;
    }
    // Only in-flight starts are kept, so a failed start is retried on the
    // next call and an evicted session gets a fresh container. The identity
    // check keeps this start from deleting a newer start for the same key.
    const initPromise: Promise<DockerContainer> = this.initContainer(
      key,
    ).finally(() => {
      if (this.initPromises.get(key) === initPromise) {
        this.initPromises.delete(key);
      }
    });
    this.initPromises.set(key, initPromise);
    return initPromise;
  }

  /**
   * Builds the image from `dockerPath` once and shares the build across every
   * session. A failed build is cleared so the next call retries it.
   */
  private ensureImageBuilt(): Promise<void> {
    const dockerPath = this.dockerPath;
    if (!dockerPath) {
      return Promise.resolve();
    }
    // `build` uses only the client and creates no container, so this
    // temporary instance owns nothing that needs to be stopped.
    this.buildPromise ??= new DockerContainer(this.containerOptions)
      .build(dockerPath)
      .catch((error: unknown) => {
        this.buildPromise = undefined;
        throw error;
      });
    return this.buildPromise;
  }

  private async initContainer(key: string): Promise<DockerContainer> {
    await this.ensureImageBuilt();
    if (this.closing) {
      throw new Error(
        'ContainerCodeExecutor closed during container initialization.',
      );
    }
    const container = new DockerContainer(this.containerOptions);

    // Probe python3 after start: it is the baseline the default image
    // guarantees. If the start or the probe fails, stop the container so a
    // created container is not left behind.
    try {
      await container.start();
      const {exitCode} = await container.execute(
        ['which', 'python3'],
        this.timeoutSeconds,
      );
      if (exitCode !== 0) {
        throw new Error('python3 is not installed in the container.');
      }
    } catch (error) {
      await container.stop().catch((stopError: unknown) => {
        logger.debug(
          `Failed to stop container after failed start: ${stopError}`,
        );
      });
      throw error;
    }

    if (this.closing) {
      await container.stop().catch((stopError: unknown) => {
        logger.debug(`Failed to stop container during close: ${stopError}`);
      });
      throw new Error(
        'ContainerCodeExecutor closed during container initialization.',
      );
    }

    // Register and evict in one synchronous block so no other call can
    // interleave between the two.
    this.containers.set(key, container);
    this.evictLeastRecentlyUsed();
    return container;
  }

  /**
   * Stops the least recently used idle session containers until the count is
   * within `maxContainers`. A session with a call in progress is skipped, which
   * includes the caller that just registered its container; if every session
   * is busy, the overshoot stays until a call ends. The stop is not awaited so
   * the caller is not delayed by another session's teardown.
   */
  private evictLeastRecentlyUsed(): void {
    if (this.maxContainers === undefined) {
      return;
    }
    // Deleting the current entry while iterating a Map is safe.
    for (const [key, container] of this.containers) {
      if (this.containers.size <= this.maxContainers) {
        return;
      }
      if (this.activeExecutions.has(key)) {
        continue;
      }
      this.containers.delete(key);
      void container.stop().catch((error: unknown) => {
        logger.debug(`Failed to stop evicted container: ${error}`);
      });
    }
  }
}

/**
 * Returns a key identifying the session a call belongs to, so each session
 * gets its own container. Joined via JSON.stringify rather than a delimited
 * string so that no combination of appName/userId/session id values can
 * collide into the same key regardless of what characters they contain.
 * Calls without a session identity share one default container.
 */
function sessionKey(
  invocationContext?: ExecuteCodeParams['invocationContext'],
): string {
  const session = invocationContext?.session;
  if (!session) {
    return 'default';
  }
  return JSON.stringify([session.appName, session.userId, session.id]);
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
