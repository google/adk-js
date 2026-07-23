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
import {logger} from '../../src/utils/logger.js';

// Mock the dynamically-imported dockerode module so the lazy client
// construction path can be exercised without a real Docker daemon.
vi.mock('dockerode', () => ({default: vi.fn()}));

/** Configuration for the fake Docker client used by these tests. */
interface MockConfig {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  buildError?: Error;
  stopError?: Error;
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

/**
 * Builds a fake Docker client that mimics the streaming exec protocol without
 * touching a real daemon.
 */
function createMockDocker(config: MockConfig = {}): {
  docker: MockDocker;
  container: MockContainer;
} {
  const {
    stdout = '',
    stderr = '',
    exitCode = 0,
    buildError,
    stopError,
  } = config;

  const container: MockContainer = {
    id: 'test-container-id',
    exec: vi.fn().mockImplementation(async () => ({
      start: vi.fn().mockResolvedValue(new PassThrough()),
      inspect: vi.fn().mockResolvedValue({ExitCode: exitCode}),
    })),
    start: vi.fn().mockResolvedValue(undefined),
    stop: stopError
      ? vi.fn().mockRejectedValue(stopError)
      : vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };

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

function makeParams(code: string): ExecuteCodeParams {
  return {
    invocationContext: {} as unknown as InvocationContext,
    codeExecutionInput: {
      code,
      language: CodeExecutionLanguage.PYTHON,
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

    // First exec verifies python; second runs the user code.
    expect(container.exec.mock.calls[1][0].Cmd).toEqual([
      'python3',
      '-c',
      'print("hello from the sandbox")',
    ]);
    expect(container.exec.mock.calls[1][0].Tty).toBeUndefined();

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
    const {docker} = createMockDocker({exitCode: 1});
    const executor = new ContainerCodeExecutor({
      image: 'test-image',
      docker: asDocker(docker),
    });

    await expect(executor.executeCode(makeParams('print(1)'))).rejects.toThrow(
      'python3 is not installed in the container.',
    );
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

  describe('lazy client construction', () => {
    beforeEach(() => {
      vi.mocked(Dockerode).mockReset();
    });

    it('lazily loads dockerode and builds a default client when none is injected', async () => {
      const {docker} = createMockDocker();
      vi.mocked(Dockerode).mockReturnValue(asDocker(docker));

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
      vi.mocked(Dockerode).mockReturnValue(asDocker(docker));

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
    function getExitHandler(): () => Promise<void> {
      const onSigint = process.listeners('SIGINT');
      const onSigterm = process.listeners('SIGTERM');
      const handler = onSigint.find((h) =>
        (onSigterm as unknown[]).includes(h),
      );
      if (!handler) {
        throw new Error('exit handler was not registered');
      }
      return handler as unknown as () => Promise<void>;
    }

    it('stops and removes tracked containers on exit', async () => {
      const {docker, container} = createMockDocker();
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });
      await executor.executeCode(makeParams('print(1)'));

      await getExitHandler()();

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });

    it('logs and swallows cleanup errors on exit', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const {docker} = createMockDocker({stopError: new Error('boom')});
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        docker: asDocker(docker),
      });
      await executor.executeCode(makeParams('print(1)'));

      await expect(getExitHandler()()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
