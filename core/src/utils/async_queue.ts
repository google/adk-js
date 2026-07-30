/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A generic, single-consumer async queue that implements AsyncIterable,
 * bridging a *push* producer to a *pull* consumer (`for await (const x of q)`).
 *
 * Producers call {@link push} as values are produced and {@link close} (or
 * {@link fail}) when finished. A single consumer drains the queue.
 *
 * Semantics:
 *  - Buffered items are always delivered before an end/error signal.
 *  - {@link close} ends iteration cleanly (`done: true`); idempotent.
 *  - {@link fail} surfaces the error to the consumer *after* any buffered items
 *    have been drained; it is sticky (first failure wins) and also closes the
 *    queue, so a later `close()` can't discard the error.
 *  - {@link push} after close/fail is ignored (the producer has already
 *    signalled completion).
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private failure?: {error: unknown};

  /** Whether the queue has been closed or failed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of items buffered and not yet consumed. */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Enqueues a value. If a consumer is currently awaiting, it is resolved
   * immediately; otherwise the value is buffered. No-op once closed/failed.
   */
  push(value: T) {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver.resolve({value, done: false});
    } else {
      this.queue.push(value);
    }
  }

  /**
   * Signals that production failed. Buffered items are still delivered first;
   * once the buffer drains, the consumer's next `next()` rejects with `error`.
   * Sticky (first failure wins) and closes the queue.
   */
  fail(error: unknown) {
    if (this.failure) return;
    this.failure = {error};
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!.reject(error);
    }
  }

  /** @deprecated Alias for {@link fail}; kept for existing callers. */
  error(err: unknown) {
    this.fail(err);
  }

  /**
   * Signals that no more items will be produced. Any awaiting consumer receives
   * `{done: true}`. Idempotent.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!.resolve({value: undefined as never, done: true});
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({value: this.queue.shift()!, done: false});
        }
        if (this.failure) {
          return Promise.reject(this.failure.error);
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
