/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Dockerode from 'dockerode';
import {PassThrough} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
// DockerContainer is an internal implementation detail of
// ContainerCodeExecutor and is deliberately not part of the public
// `@google/adk` surface, so it is imported directly.
import {DockerContainer} from '../../src/code_executors/docker_container.js';

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

/** Builds a fake Docker client that never touches a real daemon. */
function createMockDocker(): {
  docker: MockDocker;
  container: {
    id: string;
    exec: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
} {
  const container = {
    id: 'test-container-id',
    exec: vi.fn().mockImplementation(async () => ({
      start: vi.fn().mockResolvedValue(new PassThrough()),
      inspect: vi.fn().mockResolvedValue({ExitCode: 0}),
    })),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const docker: MockDocker = {
    createContainer: vi.fn().mockResolvedValue(container),
    buildImage: vi.fn().mockResolvedValue(new PassThrough()),
    modem: {
      demuxStream: vi
        .fn()
        .mockImplementation((src: PassThrough) =>
          setImmediate(() => src.emit('end')),
        ),
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

  it('can be started again after stop', async () => {
    const {docker} = createMockDocker();
    const subject = newContainer(docker);

    await subject.start();
    await subject.stop();
    await expect(subject.start()).resolves.toBeUndefined();

    expect(docker.createContainer).toHaveBeenCalledTimes(2);

    await subject.stop();
  });

  it('throws when executing before start', async () => {
    const {docker} = createMockDocker();
    const subject = newContainer(docker);

    await expect(subject.execute(['echo', 'hi'])).rejects.toThrow(
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
