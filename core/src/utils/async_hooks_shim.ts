/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export class AsyncLocalStorage<T> {
  private store: T | undefined;
  run<R>(store: T, callback: () => R): R {
    const previous = this.store;
    this.store = store;
    try {
      return callback();
    } finally {
      this.store = previous;
    }
  }
  getStore(): T | undefined {
    return this.store;
  }
}
