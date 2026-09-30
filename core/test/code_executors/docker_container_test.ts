/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Dockerode from 'dockerode';
import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
// DockerContainer is an internal implementation detail of
// ContainerCodeExecutor and is deliberately not part of the public
// `@google/adk` surface, so it is imported directly.
import {
  DockerContainer,
  TIMEOUT_EXIT_CODE,
} from '../../src/code_executors/docker_container.js';

// Every test here injects a client, so dockerode is never loaded; this mock
// is a guardrail so a future non-injecting test cannot reach a real daemon.
// The lazy-load path itself is covered in container_code_executor_test.ts.
vi.mock('dockerode', () => ({default: vi.fn()}));

interface MockDocker {
  createContainer: ReturnType<typeof vi.fn>;
  buildImage: ReturnType<typeof vi.fn>;
  modem: {
    demuxStream: ReturnType<typeof vi.fn>;
    followProgress: ReturnType<typeof vi.fn>;
  };
}

interface MockConfig {
  removeError?: Error;
  /** Exec inspect results returned in order; the last repeats. */
  inspectResults?: Array<{Running?: boolean; ExitCode: number | null}>;
  /** When true, the exec stream never emits 'end'. */
  neverEnd?: boolean;
}

/** Builds a fake Docker client that never touches a real daemon. */
function createMockDocker(config: MockConfig = {}): {
  docker: MockDocker;
  container: {
    id: string;
    exec: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
} {
  const inspectResults = config.inspectResults ?? [{ExitCode: 0}];
  let inspectCall = 0;

  const container = {
    id: 'test-container-id',
    exec: vi.fn().mockImplementation(async () => ({
      start: vi.fn().mockResolvedValue(new PassThrough()),
      inspect: vi.fn().mockImplementation(async () => {
        const result =
          inspectResults[Math.min(inspectCall, inspectResults.length - 1)];
        inspectCall++;
        return result;
      }),
    })),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: config.removeError
      ? vi.fn().mockRejectedValue(config.removeError)
      : vi.fn().mockResolvedValue(undefined),
  };

  const docker: MockDocker = {
    createContainer: vi.fn().mockResolvedValue(container),
    buildImage: vi.fn().mockResolvedValue(new PassThrough()),
    modem: {
      demuxStream: vi.fn().mockImplementation((src: PassThrough) => {
        if (!config.neverEnd) {
          setImmediate(() => src.emit('end'));
        }
      }),
      followProgress: vi
        .fn()
        .mockImplementation(
          (_stream: unknown, cb: (err: Error | null) => void) => cb(null),
        ),
    },
  };

  return {docker, container};
}

function newContainer(docker: MockDocker): DockerContainer {
  return new DockerContainer({
    image: 'test-image',
    networkEnabled: false,
    docker: docker as unknown as Dockerode,
  });
}

describe('DockerContainer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when start is called twice', async () => {
    const {docker} = createMockDocker();
    const subject = newContainer(docker);

    await subject.start();

    // Without the guard the second start would silently overwrite the handle,
    // orphaning the first container: it stays tracked for exit cleanup but can
    // no longer be stopped through this instance.
    await expect(subject.start()).rejects.toThrow(
      'Container is already started.',
    );
    expect(docker.createContainer).toHaveBeenCalledTimes(1);

    await subject.stop();
  });

  it('starts the container with a long-lived keep-alive command', async () => {
    const {docker} = createMockDocker();
    const subject = newContainer(docker);

    await subject.start();

    // Without an explicit command the container relies on the image's default
    // CMD staying alive; an image whose CMD exits leaves every exec failing.
    expect(docker.createContainer.mock.calls[0][0].Cmd).toEqual([
      'tail',
      '-f',
      '/dev/null',
    ]);

    await subject.stop();
  });

  it('can be started again after stop', async () => {
    const {docker} = createMockDocker();
    const subject = newContainer(docker);

    await subject.start();
    await subject.stop();
    await expect(subject.start()).resolves.toBeUndefined();

    expect(docker.createContainer).toHaveBeenCalledTimes(2);

    await subject.stop();
  });

  it('force-removes the container on stop', async () => {
    const {docker, container} = createMockDocker();
    const subject = newContainer(docker);

    await subject.start();
    await subject.stop();

    expect(container.remove).toHaveBeenCalledWith({force: true});
  });

  it('keeps the handle when removal fails so cleanup can retry', async () => {
    const {docker, container} = createMockDocker({
      removeError: new Error('boom'),
    });
    const subject = newContainer(docker);

    await subject.start();
    await subject.stop();

    // Removal failed, so the container is still tracked: a second start must
    // reject rather than orphan the running container.
    await expect(subject.start()).rejects.toThrow(
      'Container is already started.',
    );
    expect(container.remove).toHaveBeenCalledTimes(1);
  });

  it('polls inspect until the exec is no longer running', async () => {
    const {docker} = createMockDocker({
      inspectResults: [
        {Running: true, ExitCode: null},
        {Running: false, ExitCode: 7},
      ],
    });
    const subject = newContainer(docker);

    await subject.start();
    const result = await subject.execute(['echo', 'hi'], 300);

    // The first inspect reports Running with a null code; without polling the
    // caller would misread that as a failed command.
    expect(result.exitCode).toBe(7);

    await subject.stop();
  });

  it('bounds the wait when the exec stream never ends', async () => {
    vi.useFakeTimers();
    const {docker} = createMockDocker({neverEnd: true});
    const subject = newContainer(docker);

    await subject.start();
    const pending = subject.execute(['sleep', '100'], 1);
    await vi.advanceTimersByTimeAsync(6001);
    const result = await pending;

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);

    vi.useRealTimers();
    await subject.stop();
  });

  it('throws when executing before start', async () => {
    const {docker} = createMockDocker();
    const subject = newContainer(docker);

    await expect(subject.execute(['echo', 'hi'], 300)).rejects.toThrow(
      'Container is not started.',
    );
  });

  it('stop is a no-op when never started', async () => {
    const {docker, container} = createMockDocker();
    const subject = newContainer(docker);

    await expect(subject.stop()).resolves.toBeUndefined();
    expect(container.stop).not.toHaveBeenCalled();
  });
});
