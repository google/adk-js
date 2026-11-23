/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  ContainerCodeExecutor,
  ExecuteCodeParams,
  InvocationContext,
} from '@google/adk';
import Dockerode from 'dockerode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DockerContainer} from '../../src/code_executors/docker_container.js';
import {logger} from '../../src/utils/logger.js';

// Mock the dynamically-imported dockerode module so the lazy client
// construction path can be exercised without a real Docker daemon.
vi.mock('dockerode', () => ({default: vi.fn()}));

/** Configuration for the fake Docker client used by these tests. */
interface MockConfig {
  stdout?: string;
  stderr?: string;
  /** Exit code returned by the user-code exec. */
  exitCode?: number | null;
  /** Exit code returned by the `which python3` probe exec. */
  probeExitCode?: number;
  buildError?: Error;
  stopError?: Error;
  removeError?: Error;
  /** When set, a user-code exec waits for this promise before it runs. */
  execGate?: Promise<void>;
}

interface MockContainer {
  id: string;
  exec: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

interface MockDocker {
  createContainer: ReturnType<typeof vi.fn>;
  buildImage: ReturnType<typeof vi.fn>;
  modem: {
    demuxStream: ReturnType<typeof vi.fn>;
    followProgress: ReturnType<typeof vi.fn>;
  };
}

/** Builds a fake dockerode container whose execs report the given exits. */
function createMockContainer(
  config: MockConfig = {},
  id = 'test-container-id',
): MockContainer {
  const {
    exitCode = 0,
    probeExitCode = 0,
    stopError,
    removeError,
    execGate,
  } = config;
  return {
    id,
    exec: vi.fn().mockImplementation(async (opts: {Cmd: string[]}) => {
      // The first exec is the `which python3` probe; user code follows.
      const isProbe = opts.Cmd[0] === 'which';
      if (!isProbe && execGate) {
        await execGate;
      }
      return {
        start: vi.fn().mockResolvedValue(new PassThrough()),
        inspect: vi
          .fn()
          .mockResolvedValue({ExitCode: isProbe ? probeExitCode : exitCode}),
      };
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: stopError
      ? vi.fn().mockRejectedValue(stopError)
      : vi.fn().mockResolvedValue(undefined),
    remove: removeError
      ? vi.fn().mockRejectedValue(removeError)
      : vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Builds a fake Docker client that mimics the streaming exec protocol without
 * touching a real daemon.
 */
function createMockDocker(config: MockConfig = {}): {
  docker: MockDocker;
  container: MockContainer;
} {
  const {stdout = '', stderr = '', buildError} = config;
  const container = createMockContainer(config);

  const docker: MockDocker = {
    createContainer: vi.fn().mockResolvedValue(container),
    buildImage: vi.fn().mockResolvedValue(new PassThrough()),
    modem: {
      demuxStream: vi
        .fn()
        .mockImplementation(
          (src: PassThrough, out: PassThrough, err: PassThrough) => {
            if (stdout) out.write(Buffer.from(stdout));
            if (stderr) err.write(Buffer.from(stderr));
            setImmediate(() => src.emit('end'));
          },
        ),
      followProgress: vi
        .fn()
        .mockImplementation(
          (_stream: unknown, cb: (err: Error | null) => void) =>
            cb(buildError ?? null),
        ),
    },
  };

  return {docker, container};
}

function asDocker(docker: MockDocker): Dockerode {
  return docker as unknown as Dockerode;
}

/**
 * Builds an ExecuteCodeParams with a realistic session, defaulting to a
 * fixed (appName, userId, sessionId) triple so existing tests that don't
 * care about session identity keep behaving as a single session. Tests
 * that specifically exercise per-session isolation pass a distinct
 * `sessionId` to get a different container.
 */
function makeParams(
  code: string,
  language: CodeExecutionLanguage = CodeExecutionLanguage.PYTHON,
  sessionId = 'test-session',
): ExecuteCodeParams {
  return {
    invocationContext: {
      session: {
        appName: 'test-app',
        userId: 'test-user',
        id: sessionId,
      },
    } as unknown as InvocationContext,
    codeExecutionInput: {
      code,
      language,
      inputFiles: [],
    },
  };
}

describe('ContainerCodeExecutor', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, {recursive: true, force: true});
    }
    vi.restoreAllMocks();
  });

  function createDockerContext(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-cce-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    tempDirs.push(dir);
    return dir;
  }

  it('throws when neither image nor dockerPath is set', () => {
    expect(() => new ContainerCodeExecutor()).toThrow(
      'Either image or dockerPath must be set for ContainerCodeExecutor.',
    );
  });

  it('freezes stateful and optimizeDataFile to false', () => {
    const {docker} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });
    expect(executor.stateful).toBe(false);
    expect(executor.optimizeDataFile).toBe(false);
  });

  it('hardens the container by default', async () => {
    const {docker} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await executor.executeCode(makeParams('print(1)'));

    const opts = docker.createContainer.mock.calls[0][0];
    expect(opts.Image).toBe('test-image');
    expect(opts.Tty).toBe(true);
    expect(opts.NetworkDisabled).toBe(true);
    expect(opts.HostConfig.CapDrop).toEqual(['ALL']);
    expect(opts.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);

    await executor.close();
  });

  it('leaves networking enabled when the caller opts in', async () => {
    const {docker} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      networkEnabled: true,
      docker: asDocker(docker),
    });

    await executor.executeCode(makeParams('print(1)'));

    const opts = docker.createContainer.mock.calls[0][0];
    expect(opts.NetworkDisabled).toBe(false);

    await executor.close();
  });

  it('runs python3 -c with the provided code and returns demuxed output', async () => {
    const {docker, container} = createMockDocker({
      stdout: 'hello from the sandbox\n',
      stderr: 'a warning\n',
    });
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    const result = await executor.executeCode(
      makeParams('print("hello from the sandbox")'),
    );

    expect(result.stdout).toBe('hello from the sandbox\n');
    expect(result.stderr).toBe('a warning\n');
    expect(result.outputFiles).toEqual([]);

    // First exec verifies python; second runs the user code, wrapped in the
    // in-container timeout so a wedged run cannot hold the session container.
    expect(container.exec.mock.calls[1][0].Cmd).toEqual([
      'timeout',
      '-s',
      'KILL',
      '300',
      'python3',
      '-c',
      'print("hello from the sandbox")',
    ]);
    expect(container.exec.mock.calls[1][0].Tty).toBeUndefined();

    await executor.close();
  });

  it.each([
    [
      CodeExecutionLanguage.JAVASCRIPT,
      'console.log(1)',
      ['node', '-e', 'console.log(1)'],
    ],
    [
      CodeExecutionLanguage.TYPESCRIPT,
      'const x: number = 1;',
      ['tsx', '--eval', 'const x: number = 1;'],
    ],
    [CodeExecutionLanguage.SHELL, 'echo hi', ['sh', '-c', 'echo hi']],
  ])(
    'runs %s code with the matching interpreter',
    async (language, code, cmd) => {
      const {docker, container} = createMockDocker({stdout: 'ok\n'});
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      const result = await executor.executeCode(makeParams(code, language));

      expect(result.stdout).toBe('ok\n');
      // First exec verifies python3; second runs the user code, wrapped in the
      // in-container timeout.
      expect(container.exec.mock.calls[1][0].Cmd).toEqual([
        'timeout',
        '-s',
        'KILL',
        '300',
        ...cmd,
      ]);

      await executor.close();
    },
  );

  it('throws for a language with no configured interpreter', async () => {
    const {docker} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await expect(
      executor.executeCode(
        makeParams('Write-Host 1', CodeExecutionLanguage.POWERSHELL),
      ),
    ).rejects.toThrow(/Unsupported language for ContainerCodeExecutor/);

    await executor.close();
  });

  it('builds the image from dockerPath and defaults the image tag', async () => {
    const {docker} = createMockDocker();
    const dockerPath = createDockerContext();
    const executor = new ContainerCodeExecutor({
      dockerPath,
      docker: asDocker(docker),
    });

    await executor.executeCode(makeParams('print(1)'));

    expect(docker.buildImage).toHaveBeenCalledWith(
      {context: dockerPath, src: ['Dockerfile']},
      {t: 'adk-code-executor:latest'},
    );
    expect(docker.modem.followProgress).toHaveBeenCalled();
    // followProgress must resolve before the container is created.
    const buildOrder =
      docker.buildImage.mock.invocationCallOrder[0] <
      docker.createContainer.mock.invocationCallOrder[0];
    expect(buildOrder).toBe(true);
    expect(docker.createContainer.mock.calls[0][0].Image).toBe(
      'adk-code-executor:latest',
    );

    await executor.close();
  });

  it('throws when the docker path does not exist', async () => {
    const {docker} = createMockDocker();
    const missing = path.join(os.tmpdir(), 'adk-cce-does-not-exist-xyz');
    const executor = new ContainerCodeExecutor({
      dockerPath: missing,
      docker: asDocker(docker),
    });

    await expect(executor.executeCode(makeParams('print(1)'))).rejects.toThrow(
      `Invalid Docker path: ${path.resolve(missing)}`,
    );
  });

  it('surfaces image build failures', async () => {
    const {docker} = createMockDocker({buildError: new Error('build failed')});
    const dockerPath = createDockerContext();
    const executor = new ContainerCodeExecutor({
      dockerPath,
      docker: asDocker(docker),
    });

    await expect(executor.executeCode(makeParams('print(1)'))).rejects.toThrow(
      'build failed',
    );
  });

  it('throws when python3 is not installed in the container', async () => {
    const {docker} = createMockDocker({probeExitCode: 1});
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await expect(executor.executeCode(makeParams('print(1)'))).rejects.toThrow(
      'python3 is not installed in the container.',
    );
  });

  it('reports a non-zero exit as stderr when the program wrote none', async () => {
    // Empty stderr maps to OUTCOME_OK downstream, so an exit-1-with-no-stderr
    // program would otherwise look successful to the model.
    const {docker} = createMockDocker({exitCode: 1});
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    const result = await executor.executeCode(
      makeParams('import sys; sys.exit(1)'),
    );

    expect(result.stderr).toBe('Exit code 1');

    await executor.close();
  });

  it('keeps existing stderr on a non-zero exit', async () => {
    const {docker} = createMockDocker({exitCode: 1, stderr: 'boom\n'});
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    const result = await executor.executeCode(
      makeParams('raise SystemExit(1)'),
    );

    expect(result.stderr).toBe('boom\n');

    await executor.close();
  });

  it('appends a timeout message when the run hits the deadline', async () => {
    const {docker} = createMockDocker({exitCode: 124});
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      timeoutSeconds: 5,
      docker: asDocker(docker),
    });

    const result = await executor.executeCode(makeParams('while True: pass'));

    expect(result.stderr).toBe('Code execution timed out after 5 seconds.');

    await executor.close();
  });

  it('rejects a non-positive timeout', () => {
    expect(
      () => new ContainerCodeExecutor({image: 'test-image', timeoutSeconds: 0}),
    ).toThrow(
      'timeoutSeconds must be greater than 0 for ContainerCodeExecutor.',
    );
  });

  it('forbids flipping stateful or optimizeDataFile after construction', () => {
    const {docker} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    expect(() => {
      (executor as {stateful: boolean}).stateful = true;
    }).toThrow();
    expect(() => {
      (executor as {optimizeDataFile: boolean}).optimizeDataFile = true;
    }).toThrow();
    expect(executor.stateful).toBe(false);
    expect(executor.optimizeDataFile).toBe(false);
  });

  it('initializes the container only once across calls', async () => {
    const {docker, container} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await executor.executeCode(makeParams('print(1)'));
    await executor.executeCode(makeParams('print(2)'));

    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(container.start).toHaveBeenCalledTimes(1);
    // One verification exec plus one exec per executeCode call.
    expect(container.exec).toHaveBeenCalledTimes(3);

    await executor.close();
  });

  it('stops and removes the container on close', async () => {
    const {docker, container} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await executor.executeCode(makeParams('print(1)'));
    await executor.close();

    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(container.stop.mock.invocationCallOrder[0]).toBeLessThan(
      container.remove.mock.invocationCallOrder[0],
    );
  });

  it('close is a no-op when no container was started', async () => {
    const {docker, container} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await expect(executor.close()).resolves.toBeUndefined();
    expect(container.stop).not.toHaveBeenCalled();
  });

  it('re-initializes the container after close', async () => {
    const {docker} = createMockDocker();
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await executor.executeCode(makeParams('print(1)'));
    await executor.close();
    await executor.executeCode(makeParams('print(2)'));

    expect(docker.createContainer).toHaveBeenCalledTimes(2);

    await executor.close();
  });

  it('retries init after a transient init failure', async () => {
    const {docker} = createMockDocker();
    // A rejected initPromise must not be memoized, or one hiccup would poison
    // the executor until close().
    docker.createContainer.mockRejectedValueOnce(new Error('daemon hiccup'));
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await expect(executor.executeCode(makeParams('print(1)'))).rejects.toThrow(
      'daemon hiccup',
    );
    await expect(
      executor.executeCode(makeParams('print(2)')),
    ).resolves.toBeDefined();

    await executor.close();
  });

  describe('lazy client construction', () => {
    beforeEach(() => {
      vi.mocked(Dockerode).mockReset();
    });

    it('lazily loads dockerode and builds a default client when none is injected', async () => {
      const {docker} = createMockDocker();
      vi.mocked(Dockerode).mockImplementation(function () {
        return asDocker(docker);
      });

      const executor = new ContainerCodeExecutor({image: 'test-image'});
      await executor.executeCode(makeParams('print(1)'));

      expect(Dockerode).toHaveBeenCalledWith(undefined);
      await executor.close();
    });

    it.each([
      ['unix:///var/run/docker.sock', {socketPath: '/var/run/docker.sock'}],
      [
        'tcp://127.0.0.1:2375',
        {host: '127.0.0.1', port: '2375', protocol: 'http'},
      ],
      [
        'https://127.0.0.1:2376',
        {host: '127.0.0.1', port: '2376', protocol: 'https'},
      ],
      [
        'ssh://user@127.0.0.1',
        {host: '127.0.0.1', port: undefined, protocol: 'ssh'},
      ],
    ])('maps base url %s to dockerode options', async (baseUrl, expected) => {
      const {docker} = createMockDocker();
      vi.mocked(Dockerode).mockImplementation(function () {
        return asDocker(docker);
      });

      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        baseUrl,
      });
      await executor.executeCode(makeParams('print(1)'));

      expect(Dockerode).toHaveBeenCalledWith(expected);
      await executor.close();
    });
  });

  describe('process exit cleanup', () => {
    function getExitHandler(): (signal: 'SIGINT' | 'SIGTERM') => Promise<void> {
      const onSigint = process.listeners('SIGINT');
      const onSigterm = process.listeners('SIGTERM');
      const handler = onSigint.find((h) =>
        (onSigterm as unknown[]).includes(h),
      );
      if (!handler) {
        throw new Error('exit handler was not registered');
      }
      return handler as unknown as (
        signal: 'SIGINT' | 'SIGTERM',
      ) => Promise<void>;
    }

    it('stops containers then re-raises the signal on exit', async () => {
      // Spy so the re-raise does not actually terminate the test runner.
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const {docker, container} = createMockDocker();
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });
      await executor.executeCode(makeParams('print(1)'));

      await getExitHandler()('SIGINT');

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
      // Re-raised so Node's default termination runs; otherwise the first
      // Ctrl-C would clean up and leave the process alive.
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
    });

    it('logs and swallows cleanup errors on exit', async () => {
      vi.spyOn(process, 'kill').mockImplementation(() => true);
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const {docker} = createMockDocker({removeError: new Error('boom')});
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });
      await executor.executeCode(makeParams('print(1)'));

      await expect(getExitHandler()('SIGTERM')).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('per-session container isolation', () => {
    // codeExecutor is a single property set once on an LlmAgent instance,
    // and that instance is the long-lived object serving every session the
    // agent handles -- so a single shared container would let one
    // session's filesystem state (files, environment, background
    // processes) persist into a later, unrelated session's execution.
    // Each session must get its own container.

    it('starts a separate container for a different session', async () => {
      // This is the concrete guarantee that closes the vulnerability: pre-fix,
      // a second session's exec would run in the exact same container the
      // first session used, making any file the first session wrote directly
      // readable by the second. createContainer is dockerode's actual
      // container-provisioning call, so asserting it fires once per distinct
      // session (not once total, memoized across sessions) is the real,
      // structural guarantee that one session's code never reaches another
      // session's container to read anything left behind there.
      const {docker} = createMockDocker();
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      await executor.executeCode(
        makeParams('print(1)', undefined, 'session-a'),
      );
      await executor.executeCode(
        makeParams('print(2)', undefined, 'session-b'),
      );

      expect(docker.createContainer).toHaveBeenCalledTimes(2);
    });

    it('reuses one container across multiple calls within the same session', async () => {
      const {docker} = createMockDocker();
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      await executor.executeCode(makeParams('x = 1', undefined, 'session-a'));
      await executor.executeCode(
        makeParams('print(x)', undefined, 'session-a'),
      );
      await executor.executeCode(
        makeParams('print(x)', undefined, 'session-a'),
      );

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
    });

    it("close() stops every session's container", async () => {
      const {docker, container} = createMockDocker();
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      await executor.executeCode(
        makeParams('print(1)', undefined, 'session-a'),
      );
      await executor.executeCode(
        makeParams('print(2)', undefined, 'session-b'),
      );

      await executor.close();

      // Both sessions' containers are stopped, not just the last one --
      // the mock's createContainer resolves to the same underlying object
      // both times, so this counts stop() calls per tracked session
      // (two map entries), not per distinct object identity.
      expect(container.stop).toHaveBeenCalledTimes(2);
      expect(docker.createContainer).toHaveBeenCalledTimes(2);
    });
  });

  describe('image build caching', () => {
    it('builds the image once and shares it across sessions', async () => {
      const {docker} = createMockDocker();
      const executor = new ContainerCodeExecutor({
        dockerPath: createDockerContext(),
        docker: asDocker(docker),
      });

      await executor.executeCode(
        makeParams('print(1)', undefined, 'session-1'),
      );
      await executor.executeCode(
        makeParams('print(2)', undefined, 'session-2'),
      );

      expect(docker.buildImage).toHaveBeenCalledTimes(1);
      expect(docker.modem.followProgress).toHaveBeenCalledTimes(1);
      expect(docker.createContainer).toHaveBeenCalledTimes(2);

      await executor.close();
    });

    it('shares one build between concurrent first calls', async () => {
      const {docker} = createMockDocker();
      const executor = new ContainerCodeExecutor({
        dockerPath: createDockerContext(),
        docker: asDocker(docker),
      });

      await Promise.all([
        executor.executeCode(makeParams('print(1)', undefined, 'session-1')),
        executor.executeCode(makeParams('print(2)', undefined, 'session-2')),
      ]);

      expect(docker.buildImage).toHaveBeenCalledTimes(1);
      expect(docker.createContainer).toHaveBeenCalledTimes(2);

      await executor.close();
    });

    it('retries the image build after a failed build', async () => {
      const {docker} = createMockDocker();
      docker.modem.followProgress.mockImplementationOnce(
        (_stream: unknown, cb: (err: Error | null) => void) =>
          cb(new Error('build failed')),
      );
      const executor = new ContainerCodeExecutor({
        dockerPath: createDockerContext(),
        docker: asDocker(docker),
      });

      await expect(
        executor.executeCode(makeParams('print(1)')),
      ).rejects.toThrow('build failed');
      await expect(
        executor.executeCode(makeParams('print(2)')),
      ).resolves.toBeDefined();

      expect(docker.buildImage).toHaveBeenCalledTimes(2);
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      await executor.close();
    });
  });

  describe('probe failure cleanup', () => {
    it('stops the started container when the python3 probe fails', async () => {
      const {docker, container} = createMockDocker({probeExitCode: 1});
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      await expect(
        executor.executeCode(makeParams('print(1)')),
      ).rejects.toThrow('python3 is not installed in the container.');

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);

      // close() finds no orphaned handle to stop again.
      await executor.close();
      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh container on retry after a probe failure', async () => {
      const {docker, container: failed} = createMockDocker({probeExitCode: 1});
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      await expect(
        executor.executeCode(makeParams('print(1)')),
      ).rejects.toThrow('python3 is not installed in the container.');

      const healthy = createMockContainer({}, 'healthy-container-id');
      docker.createContainer.mockResolvedValue(healthy);
      await expect(
        executor.executeCode(makeParams('print(2)')),
      ).resolves.toBeDefined();

      expect(docker.createContainer).toHaveBeenCalledTimes(2);
      expect(failed.stop).toHaveBeenCalledTimes(1);

      await executor.close();
      expect(failed.stop).toHaveBeenCalledTimes(1);
      expect(healthy.stop).toHaveBeenCalledTimes(1);
    });

    it('preserves the probe error when removing the container fails', async () => {
      const {docker} = createMockDocker({
        probeExitCode: 1,
        removeError: new Error('remove failed'),
      });
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const stop = vi
        .spyOn(DockerContainer.prototype, 'stop')
        .mockRejectedValueOnce(new Error('stop failed'));
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      await expect(
        executor.executeCode(makeParams('print(1)')),
      ).rejects.toThrow('python3 is not installed in the container.');
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('stops a created container when its start fails', async () => {
      const {docker, container} = createMockDocker();
      container.start.mockRejectedValueOnce(new Error('start failed'));
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      await expect(
        executor.executeCode(makeParams('print(1)')),
      ).rejects.toThrow('start failed');

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('close() during an in-flight start', () => {
    it('waits for the start, stops its container, and rejects the call', async () => {
      const {docker, container} = createMockDocker();
      let resolveCreate: (value: MockContainer) => void = () => {};
      docker.createContainer.mockImplementationOnce(
        () =>
          new Promise<MockContainer>((resolve) => {
            resolveCreate = resolve;
          }),
      );
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      const run = executor.executeCode(makeParams('print(1)'));
      const rejection = expect(run).rejects.toThrow(
        'ContainerCodeExecutor closed during container initialization.',
      );
      await vi.waitFor(() => {
        expect(docker.createContainer).toHaveBeenCalledTimes(1);
      });
      const closing = executor.close();
      resolveCreate(container);

      await rejection;
      await expect(closing).resolves.toBeUndefined();
      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);

      // The executor starts a fresh container after close().
      await expect(
        executor.executeCode(makeParams('print(2)')),
      ).resolves.toBeDefined();
      expect(docker.createContainer).toHaveBeenCalledTimes(2);

      await executor.close();
      expect(container.stop).toHaveBeenCalledTimes(2);
    });

    it('creates no container when close() runs during the image build', async () => {
      const {docker} = createMockDocker();
      let finishBuild: (error: Error | null) => void = () => {};
      docker.modem.followProgress.mockImplementationOnce(
        (_stream: unknown, cb: (err: Error | null) => void) => {
          finishBuild = cb;
        },
      );
      const executor = new ContainerCodeExecutor({
        dockerPath: createDockerContext(),
        docker: asDocker(docker),
      });

      const run = executor.executeCode(makeParams('print(1)'));
      const rejection = expect(run).rejects.toThrow(
        'ContainerCodeExecutor closed during container initialization.',
      );
      await vi.waitFor(() => {
        expect(docker.modem.followProgress).toHaveBeenCalledTimes(1);
      });
      const closing = executor.close();
      finishBuild(null);

      await rejection;
      await expect(closing).resolves.toBeUndefined();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('shares one teardown between concurrent close() calls', async () => {
      const {docker, container} = createMockDocker();
      let resolveCreate: (value: MockContainer) => void = () => {};
      docker.createContainer.mockImplementationOnce(
        () =>
          new Promise<MockContainer>((resolve) => {
            resolveCreate = resolve;
          }),
      );
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      const run = executor.executeCode(makeParams('print(1)'));
      const rejection = expect(run).rejects.toThrow(
        'ContainerCodeExecutor closed during container initialization.',
      );
      await vi.waitFor(() => {
        expect(docker.createContainer).toHaveBeenCalledTimes(1);
      });
      const first = executor.close();
      const second = executor.close();
      expect(second).toBe(first);
      resolveCreate(container);

      await rejection;
      await expect(Promise.all([first, second])).resolves.toBeDefined();
      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('maxContainers', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects maxContainers of %s',
      (maxContainers) => {
        expect(
          () => new ContainerCodeExecutor({image: 'test-image', maxContainers}),
        ).toThrow(
          'maxContainers must be a positive integer for ContainerCodeExecutor.',
        );
      },
    );

    it('does not evict a container that is running code', async () => {
      let releaseS1: () => void = () => {};
      const s1Gate = new Promise<void>((resolve) => {
        releaseS1 = resolve;
      });
      const {docker} = createMockDocker();
      const c1 = createMockContainer({execGate: s1Gate}, 'c1');
      const c2 = createMockContainer({}, 'c2');
      const c3 = createMockContainer({}, 'c3');
      docker.createContainer
        .mockResolvedValueOnce(c1)
        .mockResolvedValueOnce(c2)
        .mockResolvedValueOnce(c3);
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        maxContainers: 2,
        docker: asDocker(docker),
      });

      const s1Run = executor.executeCode(
        makeParams('print(1)', undefined, 'session-1'),
      );
      await vi.waitFor(() => {
        expect(c1.exec).toHaveBeenCalledTimes(2);
      });
      await executor.executeCode(
        makeParams('print(2)', undefined, 'session-2'),
      );
      await executor.executeCode(
        makeParams('print(3)', undefined, 'session-3'),
      );

      // session-1 is the least recently used but busy, so idle session-2 goes.
      await vi.waitFor(() => {
        expect(c2.remove).toHaveBeenCalledTimes(1);
      });
      expect(c1.stop).not.toHaveBeenCalled();
      expect(c3.stop).not.toHaveBeenCalled();

      releaseS1();
      await expect(s1Run).resolves.toBeDefined();
      expect(c1.stop).not.toHaveBeenCalled();

      await executor.close();
      expect(c1.stop).toHaveBeenCalledTimes(1);
      expect(c3.stop).toHaveBeenCalledTimes(1);
    });

    it('evicts a held-back container once its run ends', async () => {
      let releaseS1: () => void = () => {};
      const s1Gate = new Promise<void>((resolve) => {
        releaseS1 = resolve;
      });
      let releaseS2: () => void = () => {};
      const s2Gate = new Promise<void>((resolve) => {
        releaseS2 = resolve;
      });
      const {docker} = createMockDocker();
      const c1 = createMockContainer({execGate: s1Gate}, 'c1');
      const c2 = createMockContainer({execGate: s2Gate}, 'c2');
      docker.createContainer
        .mockResolvedValueOnce(c1)
        .mockResolvedValueOnce(c2);
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        maxContainers: 1,
        docker: asDocker(docker),
      });

      const s1Run = executor.executeCode(
        makeParams('print(1)', undefined, 'session-1'),
      );
      await vi.waitFor(() => {
        expect(c1.exec).toHaveBeenCalledTimes(2);
      });
      const s2Run = executor.executeCode(
        makeParams('print(2)', undefined, 'session-2'),
      );
      await vi.waitFor(() => {
        expect(c2.exec).toHaveBeenCalledTimes(2);
      });

      // Both sessions are busy, so the count stays over the limit.
      expect(c1.stop).not.toHaveBeenCalled();
      expect(c2.stop).not.toHaveBeenCalled();

      releaseS1();
      await expect(s1Run).resolves.toBeDefined();
      await vi.waitFor(() => {
        expect(c1.remove).toHaveBeenCalledTimes(1);
      });
      expect(c2.stop).not.toHaveBeenCalled();

      releaseS2();
      await expect(s2Run).resolves.toBeDefined();
      expect(c2.stop).not.toHaveBeenCalled();

      await executor.close();
      expect(c1.stop).toHaveBeenCalledTimes(1);
      expect(c2.stop).toHaveBeenCalledTimes(1);
    });

    it('evicts the least recently used session container', async () => {
      const {docker} = createMockDocker();
      const [c1, c2, c3, c4, c5] = [1, 2, 3, 4, 5].map((n) =>
        createMockContainer({}, `c${n}`),
      );
      docker.createContainer
        .mockResolvedValueOnce(c1)
        .mockResolvedValueOnce(c2)
        .mockResolvedValueOnce(c3)
        .mockResolvedValueOnce(c4)
        .mockResolvedValueOnce(c5);
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        maxContainers: 2,
        docker: asDocker(docker),
      });

      await executor.executeCode(
        makeParams('print(1)', undefined, 'session-1'),
      );
      await executor.executeCode(
        makeParams('print(2)', undefined, 'session-2'),
      );
      await executor.executeCode(
        makeParams('print(3)', undefined, 'session-3'),
      );

      await vi.waitFor(() => {
        expect(c1.remove).toHaveBeenCalledTimes(1);
      });
      expect(c1.stop).toHaveBeenCalledTimes(1);
      expect(c2.stop).not.toHaveBeenCalled();
      expect(c3.stop).not.toHaveBeenCalled();

      // Reusing session-2 makes it the most recently used.
      await executor.executeCode(
        makeParams('print(4)', undefined, 'session-2'),
      );
      expect(docker.createContainer).toHaveBeenCalledTimes(3);
      await executor.executeCode(
        makeParams('print(5)', undefined, 'session-4'),
      );

      await vi.waitFor(() => {
        expect(c3.remove).toHaveBeenCalledTimes(1);
      });
      expect(c3.stop).toHaveBeenCalledTimes(1);
      expect(c2.stop).not.toHaveBeenCalled();
      expect(c4.stop).not.toHaveBeenCalled();

      // An evicted session gets a new container on its next call.
      await executor.executeCode(
        makeParams('print(6)', undefined, 'session-1'),
      );
      expect(docker.createContainer).toHaveBeenCalledTimes(5);
      expect(c5.exec.mock.calls[1][0].Cmd).toEqual([
        'timeout',
        '-s',
        'KILL',
        '300',
        'python3',
        '-c',
        'print(6)',
      ]);

      await executor.close();
      expect(c2.stop).toHaveBeenCalledTimes(1);
      expect(c4.stop).toHaveBeenCalledTimes(1);
      expect(c5.stop).toHaveBeenCalledTimes(1);
    });

    it('evicts nothing when maxContainers is not set', async () => {
      const {docker} = createMockDocker();
      const containers = [1, 2, 3].map((n) => createMockContainer({}, `c${n}`));
      for (const c of containers) {
        docker.createContainer.mockResolvedValueOnce(c);
      }
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });

      for (const sessionId of ['session-1', 'session-2', 'session-3']) {
        await executor.executeCode(
          makeParams('print(1)', undefined, sessionId),
        );
      }

      for (const c of containers) {
        expect(c.stop).not.toHaveBeenCalled();
      }

      await executor.close();
    });
  });

  describe('invocation context without a session', () => {
    it('uses one default container', async () => {
      const {docker} = createMockDocker({stdout: 'ok\n'});
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });
      const params: ExecuteCodeParams = {
        ...makeParams('print(1)'),
        invocationContext: {} as unknown as InvocationContext,
      };

      const first = await executor.executeCode(params);
      const second = await executor.executeCode(params);

      expect(first.stdout).toBe('ok\n');
      expect(second.stdout).toBe('ok\n');
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      await executor.close();
    });
  });
});
