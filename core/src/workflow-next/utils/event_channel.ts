/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A single-consumer async queue that bridges the workflow engine's *push* model
 * (nodes/`ctx.runNode()` push events as they run) to the runtime's *pull* model
 * (the workflow's outer async generator drains and re-yields them).
 *
 * Producers call {@link push} as events are produced and {@link close} (or
 * {@link fail}) when finished. A single consumer drains the channel by
 * `for await (const ev of channel)`.
 *
 * Semantics:
 *  - Buffered items are always delivered before an end/error signal.
 *  - {@link close} ends iteration cleanly (`done: true`).
 *  - {@link fail} surfaces the error to the consumer *after* any buffered items
 *    have been drained.
 *  - {@link push} after close/fail is ignored (the producer has already
 *    signalled completion).
 */
export class EventChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private closed = false;
  private failure?: {error: unknown};

  /** Whether the channel has been closed or failed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of items buffered and not yet consumed. */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Enqueues an item. If a consumer is currently awaiting, it is resolved
   * immediately; otherwise the item is buffered. No-op once closed/failed.
   */
  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({value: item, done: false});
    } else {
      this.buffer.push(item);
    }
  }

  /**
   * Signals that no more items will be produced. Any awaiting consumer receives
   * `{done: true}`. Idempotent.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({value: undefined as never, done: true});
    }
  }

  /**
   * Signals that production failed. Buffered items are still delivered first;
   * once the buffer drains, the consumer's next `next()` rejects with `error`.
   * Idempotent (first failure wins).
   */
  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.failure = {error};
    this.closed = true;
    // If a consumer is awaiting, the buffer is empty, so surface the error now.
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({value: this.buffer.shift()!, done: false});
        }
        if (this.failure) {
          return Promise.reject(this.failure.error);
        }
        if (this.closed) {
          return Promise.resolve({value: undefined as never, done: true});
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({resolve, reject});
        });
      },
    };
  }
}
