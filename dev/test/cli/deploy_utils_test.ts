/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {spawnAsync} from '../../src/cli/deploy/deploy_utils.js';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  spawn: (command: string, args: string[], options: unknown) =>
    spawnMock(command, args, options),
}));

function mockChildProcess() {
  return {
    on: vi.fn((name: string, cb: (code: number) => void) => {
      if (name === 'close') {
        process.nextTick(() => cb(0));
      }
    }),
  };
}

function setPlatform(platform: typeof process.platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('spawnAsync', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.clearAllMocks();
  });

  it('runs the command through a shell on Windows so .cmd shims like gcloud resolve', async () => {
    setPlatform('win32');
    spawnMock.mockReturnValue(mockChildProcess());

    await spawnAsync('gcloud', ['version'], {stdio: 'inherit'});

    expect(spawnMock).toHaveBeenCalledWith('gcloud', ['version'], {
      stdio: 'inherit',
      shell: true,
    });
  });

  it('does not use a shell on non-Windows platforms', async () => {
    setPlatform('linux');
    spawnMock.mockReturnValue(mockChildProcess());

    await spawnAsync('gcloud', ['version'], {stdio: 'inherit'});

    expect(spawnMock).toHaveBeenCalledWith('gcloud', ['version'], {
      stdio: 'inherit',
      shell: false,
    });
  });
});
