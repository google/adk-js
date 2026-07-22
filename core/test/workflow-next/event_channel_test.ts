/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {EventChannel} from '../../src/workflow-next/utils/event_channel.js';

async function drain<T>(ch: EventChannel<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of ch) {
    out.push(item);
  }
  return out;
}

describe('Phase 1 — EventChannel', () => {
  it('delivers items pushed before draining (buffered)', async () => {
    const ch = new EventChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.close();
    expect(await drain(ch)).toEqual([1, 2, 3]);
  });

  it('delivers items pushed while a consumer is awaiting (interleaved)', async () => {
    const ch = new EventChannel<number>();
    const collected: number[] = [];
    const consumer = (async () => {
      for await (const item of ch) {
        collected.push(item);
      }
    })();

    // Push across turns of the event loop while the consumer is parked.
    await Promise.resolve();
    ch.push(10);
    await Promise.resolve();
    ch.push(20);
    await Promise.resolve();
    ch.close();

    await consumer;
    expect(collected).toEqual([10, 20]);
  });

  it('close() terminates iteration cleanly', async () => {
    const ch = new EventChannel<string>();
    ch.push('a');
    ch.close();
    ch.push('ignored-after-close');
    expect(await drain(ch)).toEqual(['a']);
    expect(ch.isClosed).toBe(true);
  });

  it('fail() surfaces the error to the consumer', async () => {
    const ch = new EventChannel<number>();
    const boom = new Error('boom');
    ch.fail(boom);
    await expect(drain(ch)).rejects.toThrow('boom');
  });

  it('fail() still drains buffered items before throwing', async () => {
    const ch = new EventChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.fail(new Error('later'));

    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const item of ch) {
          seen.push(item);
        }
      })(),
    ).rejects.toThrow('later');
    expect(seen).toEqual([1, 2]);
  });

  it('reports buffered size and ignores push after close', async () => {
    const ch = new EventChannel<number>();
    ch.push(1);
    expect(ch.size).toBe(1);
    ch.close();
    ch.push(2);
    expect(ch.size).toBe(1);
  });
});
