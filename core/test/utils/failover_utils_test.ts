/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {Router, runWithRouting} from '../../src/utils/failover_utils.js';

type Context = {requestId: string};

/**
 * Helper to collect all yielded values from an AsyncGenerator.
 */
async function collectAsync<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of gen) {
    results.push(value);
  }
  return results;
}

describe('runWithRouting', () => {
  describe('normal routing (no failover)', () => {
    it('yields values from async generator runFn', async () => {
      const items = {a: 'itemA', b: 'itemB'};
      const context: Context = {requestId: 'req-1'};
      const router: Router<string, Context> = () => 'a';

      const results = await collectAsync(
        runWithRouting(items, context, router, async function* (item) {
          yield `result:${item}`;
          yield `result2:${item}`;
        }),
      );

      expect(results).toEqual(['result:itemA', 'result2:itemA']);
    });

    it('yields single value from Promise runFn', async () => {
      const items = {x: 42};
      const context: Context = {requestId: 'req-2'};
      const router: Router<number, Context> = () => 'x';

      const results = await collectAsync(
        runWithRouting(items, context, router, async (item) => item * 2),
      );

      expect(results).toEqual([84]);
    });

    it('throws when initial router returns undefined', async () => {
      const items = {a: 'itemA'};
      const context: Context = {requestId: 'req-3'};
      const router: Router<string, Context> = () => undefined;

      await expect(
        collectAsync(runWithRouting(items, context, router, async () => 'x')),
      ).rejects.toThrow('Initial routing failed, no item selected.');
    });

    it('throws when initial key is not in items', async () => {
      const items = {a: 'itemA'};
      const context: Context = {requestId: 'req-4'};
      const router: Router<string, Context> = () => 'missing';

      await expect(
        collectAsync(runWithRouting(items, context, router, async () => 'x')),
      ).rejects.toThrow('Item not found for key: missing');
    });
  });

  describe('failover on pre-first-yield error', () => {
    it('retries with next key returned by router on failure before first yield', async () => {
      const items = {primary: 'primary-item', secondary: 'secondary-item'};
      const context: Context = {requestId: 'req-5'};

      // First call → pick primary; subsequent call → pick secondary
      const router = vi
        .fn<Router<string, Context>>()
        .mockReturnValueOnce('primary')
        .mockReturnValueOnce('secondary');

      const results = await collectAsync(
        runWithRouting(items, context, router, async function* (item) {
          if (item === 'primary-item') {
            throw new Error('primary failed');
          }
          yield `ok:${item}`;
        }),
      );

      expect(results).toEqual(['ok:secondary-item']);
      expect(router).toHaveBeenCalledTimes(2);
    });

    it('passes failedKeys and lastError to router on failover', async () => {
      const items = {a: 'A', b: 'B'};
      const context: Context = {requestId: 'req-6'};
      const originalError = new Error('a failed');

      const router = vi
        .fn<Router<string, Context>>()
        .mockImplementation((_items, _ctx, errorCtx) => {
          if (!errorCtx) return 'a';
          expect(errorCtx.failedKeys.has('a')).toBe(true);
          expect(errorCtx.lastError).toBe(originalError);
          return 'b';
        });

      await collectAsync(
        runWithRouting(items, context, router, async function* (item) {
          if (item === 'A') throw originalError;
          yield `ok:${item}`;
        }),
      );

      expect(router).toHaveBeenCalledTimes(2);
    });

    it('re-throws error when router returns undefined on failover', async () => {
      const items = {a: 'A'};
      const context: Context = {requestId: 'req-7'};
      const err = new Error('permanent failure');

      const router = vi
        .fn<Router<string, Context>>()
        .mockReturnValueOnce('a')
        .mockReturnValueOnce(undefined);

      await expect(
        collectAsync(
          runWithRouting(items, context, router, async (_item) => {
            throw err;
          }),
        ),
      ).rejects.toThrow('permanent failure');
    });

    it('re-throws error when router returns already-tried key (prevents infinite loop)', async () => {
      const items = {a: 'A'};
      const context: Context = {requestId: 'req-8'};
      const err = new Error('always fails');

      const router: Router<string, Context> = () => 'a'; // always returns same key

      await expect(
        collectAsync(
          runWithRouting(items, context, router, async (_item) => {
            throw err;
          }),
        ),
      ).rejects.toThrow('always fails');
    });

    it('does NOT failover when error occurs after first yield', async () => {
      const items = {a: 'A', b: 'B'};
      const context: Context = {requestId: 'req-9'};
      const router: Router<string, Context> = () => 'a';
      const lateError = new Error('late failure');

      await expect(
        collectAsync(
          runWithRouting(items, context, router, async function* () {
            yield 'first';
            throw lateError;
          }),
        ),
      ).rejects.toThrow('late failure');
    });
  });

  describe('router called with async result', () => {
    it('supports async router returning a Promise', async () => {
      const items = {a: 'asyncItem'};
      const context: Context = {requestId: 'req-10'};
      const router: Router<string, Context> = () => Promise.resolve('a');

      const results = await collectAsync(
        runWithRouting(items, context, router, async (item) => item),
      );

      expect(results).toEqual(['asyncItem']);
    });
  });
});
