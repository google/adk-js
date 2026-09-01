/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SessionQueue} from '@google/adk-gateway';
import {describe, expect, it} from 'vitest';

/** A task that records when it starts and ends, and honours abort. */
function tracked(log: string[], name: string, ms = 20) {
  return async (signal: AbortSignal) => {
    log.push(`start:${name}`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, {once: true});
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
    log.push(`end:${name}${signal.aborted ? ':aborted' : ''}`);
  };
}

describe('SessionQueue', () => {
  it('runs tasks in one lane one at a time, in order', async () => {
    const queue = new SessionQueue();
    const log: string[] = [];

    await Promise.all([
      queue.run('a', tracked(log, '1')),
      queue.run('a', tracked(log, '2')),
      queue.run('a', tracked(log, '3')),
    ]);

    expect(log).toEqual([
      'start:1',
      'end:1',
      'start:2',
      'end:2',
      'start:3',
      'end:3',
    ]);
  });

  it('runs separate lanes concurrently', async () => {
    const queue = new SessionQueue();
    const log: string[] = [];

    await Promise.all([
      queue.run('a', tracked(log, 'a')),
      queue.run('b', tracked(log, 'b')),
    ]);

    expect(log.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
  });

  it('reports how a task ended up', async () => {
    const queue = new SessionQueue();
    const outcome = await queue.run('a', async () => {});
    expect(outcome).toBe('ran');
  });

  it('propagates a task failure to its caller', async () => {
    const queue = new SessionQueue();
    await expect(
      queue.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('keeps the lane usable after a task fails', async () => {
    const queue = new SessionQueue();
    await queue
      .run('a', async () => {
        throw new Error('boom');
      })
      .catch(() => undefined);

    await expect(queue.run('a', async () => {})).resolves.toBe('ran');
  });

  describe('when a lane is busy', () => {
    it('queues by default', async () => {
      const queue = new SessionQueue();
      const log: string[] = [];

      const outcomes = await Promise.all([
        queue.run('a', tracked(log, '1')),
        queue.run('a', tracked(log, '2')),
      ]);

      expect(outcomes).toEqual(['ran', 'ran']);
    });

    it('drops the newcomer under the drop policy', async () => {
      const queue = new SessionQueue({onBusy: 'drop'});
      const log: string[] = [];

      const outcomes = await Promise.all([
        queue.run('a', tracked(log, '1')),
        queue.run('a', tracked(log, '2')),
      ]);

      expect(outcomes).toEqual(['ran', 'dropped']);
      expect(log).toEqual(['start:1', 'end:1']);
    });

    it('aborts the running task under the interrupt policy', async () => {
      const queue = new SessionQueue({onBusy: 'interrupt'});
      const log: string[] = [];

      await Promise.all([
        queue.run('a', tracked(log, '1', 500)),
        queue.run('a', tracked(log, '2')),
      ]);

      // The replacement starts only once the aborted task has returned, so the
      // two never overlap — which is the whole point of the lane.
      expect(log).toEqual(['start:1', 'end:1:aborted', 'start:2', 'end:2']);
    });

    it('keeps only the newest waiter under the coalesce policy', async () => {
      const queue = new SessionQueue({onBusy: 'coalesce'});
      const log: string[] = [];

      const outcomes = await Promise.all([
        queue.run('a', tracked(log, '1')),
        queue.run('a', tracked(log, '2')),
        queue.run('a', tracked(log, '3')),
      ]);

      expect(outcomes).toEqual(['ran', 'superseded', 'ran']);
      expect(log).toEqual(['start:1', 'end:1', 'start:3', 'end:3']);
    });

    it('refuses more than maxQueued waiters', async () => {
      const queue = new SessionQueue({maxQueued: 1});
      const log: string[] = [];

      const outcomes = await Promise.all([
        queue.run('a', tracked(log, '1')),
        queue.run('a', tracked(log, '2')),
        queue.run('a', tracked(log, '3')),
      ]);

      expect(outcomes).toEqual(['ran', 'ran', 'dropped']);
    });
  });

  it('forgets a lane once it goes idle', async () => {
    const queue = new SessionQueue();

    await queue.run('a', async () => {});
    await queue.run('b', async () => {});

    // Lanes are keyed by session, so retaining them would leak one entry per
    // conversation the bot has ever seen.
    expect(queue.activeLanes).toBe(0);
  });

  it('drains everything in flight', async () => {
    const queue = new SessionQueue();
    const log: string[] = [];

    void queue.run('a', tracked(log, 'a'));
    void queue.run('b', tracked(log, 'b'));
    await queue.drain();

    expect(log.filter((entry) => entry.startsWith('end:'))).toHaveLength(2);
  });

  it('aborts everything on shutdown', async () => {
    const queue = new SessionQueue();
    const log: string[] = [];

    const running = queue.run('a', tracked(log, '1', 500));
    const waiting = queue.run('a', tracked(log, '2'));
    queue.abortAll();

    await expect(running).resolves.toBe('ran');
    await expect(waiting).resolves.toBe('dropped');
    expect(log).toEqual(['start:1', 'end:1:aborted']);
  });
});
