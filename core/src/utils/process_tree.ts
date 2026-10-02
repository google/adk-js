/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn, type ChildProcess} from 'node:child_process';

/**
 * Spawn options that give a process its own killable process group on POSIX.
 * Windows descendants are terminated with `taskkill /T` instead.
 */
export function processTreeSpawnOptions(): {detached: boolean} {
  return {detached: process.platform !== 'win32'};
}

/**
 * Terminates a process and descendants that remain in its process group/tree.
 * The child must have been spawned with {@link processTreeSpawnOptions} so a
 * POSIX group signal cannot reach the current process group. A descendant that
 * deliberately detaches from that group may survive.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const {pid} = child;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', reject);
      killer.once('close', (code) => {
        if (code === 0 || code === 128) {
          resolve();
        } else {
          reject(new Error(`taskkill exited with code ${code ?? 'unknown'}`));
        }
      });
    });
    return;
  }

  try {
    // A negative PID targets the dedicated process group created by
    // `detached: true`, including descendants that inherited that group.
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
    ) {
      throw error;
    }
  }
}
