/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class AsyncLocalStorage<T> {
  private currentStore: T | undefined;

  /**
   * Executes `callback` with `store` active for its synchronous execution.
   *
   * Because browsers lack native async context propagation, this fallback
   * restores the previous store immediately in `finally` when `callback`
   * returns (before any continuation after `await`) so concurrent async
   * operations never observe or corrupt each other's store.
   */
  run<R, TArgs extends unknown[]>(
    store: T,
    callback: (...args: TArgs) => R,
    ...args: TArgs
  ): R {
    const previous = this.currentStore;
    this.currentStore = store;
    try {
      return callback(...args);
    } finally {
      this.currentStore = previous;
    }
  }

  getStore(): T | undefined {
    return this.currentStore;
  }
}
