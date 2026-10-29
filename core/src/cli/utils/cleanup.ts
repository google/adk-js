/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Runner} from '../../runner/runner.js';
import {logger} from '../../utils/logger.js';

/**
 * Maximum time in milliseconds to wait for all runners to close during cleanup.
 */
export const RUNNER_CLEANUP_TIMEOUT_MS = 30_000;

const RUNNER_CLEANUP_TIMEOUT_SYMBOL = Symbol(
  'google.adk.cli.runnerCleanupTimeout',
);

/**
 * Closes all provided {@link Runner} instances concurrently, waiting up to
 * {@link RUNNER_CLEANUP_TIMEOUT_MS} milliseconds and logging a warning if any
 * close task does not complete in time.
 *
 * @param runners The runner instances to close.
 */
export async function closeRunners(runners: readonly Runner[]): Promise<void> {
  if (runners.length === 0) {
    return;
  }

  let pendingCount = runners.length;
  const tasks = runners.map(async (runner) => {
    try {
      await runner.close();
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      logger.error(`Error closing runner ${runner.appName}: ${reason}`);
    } finally {
      pendingCount -= 1;
    }
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.allSettled(tasks).then(() => undefined),
      new Promise<typeof RUNNER_CLEANUP_TIMEOUT_SYMBOL>((resolve) => {
        timeoutId = setTimeout(
          () => resolve(RUNNER_CLEANUP_TIMEOUT_SYMBOL),
          RUNNER_CLEANUP_TIMEOUT_MS,
        );
      }),
    ]);

    if (result === RUNNER_CLEANUP_TIMEOUT_SYMBOL && pendingCount > 0) {
      logger.warn(`${pendingCount} runner close tasks didn't complete in time`);
    }
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
