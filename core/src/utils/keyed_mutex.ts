/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializes async tasks that share a key; tasks with distinct keys run
 * concurrently. Used to make read-modify-write sequences that span an
 * `await` (e.g. "list versions, compute next, write") safe under parallel
 * tool execution without serializing unrelated work.
 *
 * A task's failure does not break the chain: the next task for the key still
 * runs. Chains are dropped as soon as their last task settles, so an idle
 * mutex holds no entries.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
