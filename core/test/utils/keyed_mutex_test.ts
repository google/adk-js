/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {KeyedMutex} from '../../src/utils/keyed_mutex.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedMutex', () => {
  it('serializes tasks that share a key', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      mutex.runExclusive('k', async () => {
        log.push('a:start');
        await sleep(20);
        log.push('a:end');
      }),
      mutex.runExclusive('k', async () => {
        log.push('b:start');
        await sleep(1);
        log.push('b:end');
      }),
    ]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs tasks with distinct keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      mutex.runExclusive('left', async () => {
        log.push('left:start');
        await sleep(20);
        log.push('left:end');
      }),
      mutex.runExclusive('right', async () => {
        log.push('right:start');
        await sleep(1);
        log.push('right:end');
      }),
    ]);
    expect(log.indexOf('right:end')).toBeLessThan(log.indexOf('left:end'));
  });

  it('keeps the chain alive after a task rejects', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.runExclusive('k', async () => {
      throw new Error('boom');
    });
    const next = mutex.runExclusive('k', async () => 'survived');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('survived');
  });

  it('returns each task its own result', async () => {
    const mutex = new KeyedMutex();
    const results = await Promise.all([
      mutex.runExclusive('k', async () => 1),
      mutex.runExclusive('k', async () => 2),
    ]);
    expect(results).toEqual([1, 2]);
  });
});
