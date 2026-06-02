/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A generic, async-safe queue that implements AsyncIterable.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private errorVal?: unknown;

  push(value: T) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      const {resolve} = this.resolvers.shift()!;
      resolve({value, done: false});
    } else {
      this.queue.push(value);
    }
  }

  error(err: unknown) {
    this.errorVal = err;
    while (this.resolvers.length > 0) {
      const {reject} = this.resolvers.shift()!;
      reject(err);
    }
  }

  close() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const {resolve} = this.resolvers.shift()!;
      resolve({value: undefined as never, done: true});
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.errorVal) {
          const err = this.errorVal;
          this.errorVal = undefined;
          return Promise.reject(err);
        }
        if (this.queue.length > 0) {
          return Promise.resolve({value: this.queue.shift()!, done: false});
        }
        if (this.closed) {
          return Promise.resolve({value: undefined as never, done: true});
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push({resolve, reject});
        });
      },
    };
  }
}
