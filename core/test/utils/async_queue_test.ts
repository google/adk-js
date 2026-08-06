/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {AsyncQueue} from '../../src/utils/async_queue.js';

describe('AsyncQueue', () => {
  it('should yield pushed values', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    const results: number[] = [];
    for await (const val of queue) {
      results.push(val);
    }

    expect(results).toEqual([1, 2]);
  });

  it('should handle values pushed after iteration started', async () => {
    const queue = new AsyncQueue<number>();
    const results: number[] = [];

    const iteration = (async () => {
      for await (const val of queue) {
        results.push(val);
      }
    })();

    queue.push(1);
    queue.push(2);
    queue.close();

    await iteration;

    expect(results).toEqual([1, 2]);
  });

  it('should terminate iteration when closed empty', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();

    const results: number[] = [];
    for await (const val of queue) {
      results.push(val);
    }

    expect(results).toEqual([]);
  });

  it('should propagate error to pending and subsequent next calls', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();

    const pendingNext = iterator.next();
    queue.error(new Error('Test error'));

    await expect(pendingNext).rejects.toThrow('Test error');
    await expect(iterator.next()).rejects.toThrow('Test error');
  });

  it('should ignore push after close', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(1);

    const results: number[] = [];
    for await (const val of queue) {
      results.push(val);
    }

    expect(results).toEqual([]);
  });

  it('should resolve pending next() call when closed', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.close();
    const res = await pending;
    expect(res.done).toBe(true);
  });
});

describe('AsyncQueue — failure & lifecycle', () => {
  async function drain<T>(queue: AsyncQueue<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of queue) {
      out.push(item);
    }
    return out;
  }

  it('exposes isClosed and buffered size', () => {
    const queue = new AsyncQueue<number>();
    expect(queue.isClosed).toBe(false);
    queue.push(1);
    expect(queue.size).toBe(1);
    queue.close();
    expect(queue.isClosed).toBe(true);
    queue.push(2); // ignored after close
    expect(queue.size).toBe(1);
  });

  it('fail() surfaces the error to the consumer', async () => {
    const queue = new AsyncQueue<number>();
    queue.fail(new Error('boom'));
    await expect(drain(queue)).rejects.toThrow('boom');
  });

  it('fail() drains buffered items before throwing (drain-before-error)', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.fail(new Error('later'));

    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const item of queue) {
          seen.push(item);
        }
      })(),
    ).rejects.toThrow('later');
    expect(seen).toEqual([1, 2]);
  });

  it('keeps the failure sticky across repeated next() calls', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    queue.fail(new Error('sticky'));
    await expect(iterator.next()).rejects.toThrow('sticky');
    await expect(iterator.next()).rejects.toThrow('sticky');
  });

  it('does not swallow a fail() that lands after close()', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.fail(new Error('late failure'));
    await expect(drain(queue)).rejects.toThrow('late failure');
  });

  it('keeps the first failure (first failure wins)', async () => {
    const queue = new AsyncQueue<number>();
    queue.fail(new Error('first'));
    queue.fail(new Error('second'));
    await expect(drain(queue)).rejects.toThrow('first');
  });
});
