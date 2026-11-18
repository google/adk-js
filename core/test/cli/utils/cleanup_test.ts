/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {closeRunners, Runner, RUNNER_CLEANUP_TIMEOUT_MS} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

function createFakeRunner(
  appName: string,
  closeImpl: () => Promise<void>,
): Runner {
  return {
    appName,
    close: vi.fn(closeImpl),
  } as unknown as Runner;
}

describe('cli/utils/cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns immediately when given an empty runners array', async () => {
    await expect(closeRunners([])).resolves.toBeUndefined();
  });

  it('closes all provided runners concurrently', async () => {
    const order: string[] = [];
    const runnerA = createFakeRunner('app_a', async () => {
      order.push('a_start');
      await Promise.resolve();
      order.push('a_end');
    });
    const runnerB = createFakeRunner('app_b', async () => {
      order.push('b_start');
      await Promise.resolve();
      order.push('b_end');
    });

    await closeRunners([runnerA, runnerB]);

    expect(runnerA.close).toHaveBeenCalledTimes(1);
    expect(runnerB.close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['a_start', 'b_start', 'a_end', 'b_end']);
  });

  it('isolates errors when one runner rejects during close', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const failingRunner = createFakeRunner('failing_app', async () => {
      throw new Error('close failed');
    });
    const healthyRunner = createFakeRunner('healthy_app', async () => {});

    await expect(
      closeRunners([failingRunner, healthyRunner]),
    ).resolves.toBeUndefined();

    expect(healthyRunner.close).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error closing runner failing_app: close failed'),
    );
  });

  it('logs a warning when a runner close task does not finish before RUNNER_CLEANUP_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fastRunner = createFakeRunner('fast_app', async () => {});
    const hangingRunner = createFakeRunner(
      'hanging_app',
      () => new Promise<void>(() => {}),
    );

    const closePromise = closeRunners([fastRunner, hangingRunner]);
    await vi.advanceTimersByTimeAsync(RUNNER_CLEANUP_TIMEOUT_MS);
    await closePromise;

    expect(fastRunner.close).toHaveBeenCalledTimes(1);
    expect(hangingRunner.close).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "1 runner close tasks didn't complete in time",
    );
  });
});
