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

  describe('prototype key protection and own property validation', () => {
    it.each([
      'toString',
      'valueOf',
      'constructor',
      'hasOwnProperty',
      '__proto__',
    ])(
      'rejects Object.prototype key %s on initial routing without calling runFn',
      async (key) => {
        const items = {a: 'itemA'};
        const context: Context = {requestId: 'req-proto-init'};
        const router = vi.fn<Router<string, Context>>().mockReturnValue(key);
        const runFn = vi.fn().mockResolvedValue('unexpected');

        await expect(
          collectAsync(runWithRouting(items, context, router, runFn)),
        ).rejects.toThrow(`Item not found for key: ${key}`);

        expect(runFn).not.toHaveBeenCalled();
        expect(router).toHaveBeenCalledTimes(1);
      },
    );

    it('rejects missing key returned on failover', async () => {
      const items = {primary: 'item-primary'};
      const context: Context = {requestId: 'req-failover-missing'};
      const router = vi
        .fn<Router<string, Context>>()
        .mockReturnValueOnce('primary')
        .mockReturnValueOnce('missing');
      const runFn = vi.fn(async (item: string) => {
        if (item === 'item-primary') {
          throw new Error('primary failed');
        }
        return 'ok';
      });

      await expect(
        collectAsync(runWithRouting(items, context, router, runFn)),
      ).rejects.toThrow('Item not found for key: missing');

      expect(runFn).toHaveBeenCalledTimes(1);
      expect(runFn).toHaveBeenCalledWith('item-primary');
      expect(router).toHaveBeenCalledTimes(2);
    });

    it.each(['toString', 'constructor', 'valueOf'])(
      'rejects Object.prototype key %s on failover without calling runFn with prototype',
      async (protoKey) => {
        const items = {primary: 'item-primary'};
        const context: Context = {requestId: 'req-failover-proto'};
        const router = vi
          .fn<Router<string, Context>>()
          .mockReturnValueOnce('primary')
          .mockReturnValueOnce(protoKey);
        const runFn = vi.fn(async (item: string) => {
          if (item === 'item-primary') {
            throw new Error('primary failed');
          }
          return 'ok';
        });

        await expect(
          collectAsync(runWithRouting(items, context, router, runFn)),
        ).rejects.toThrow(`Item not found for key: ${protoKey}`);

        expect(runFn).toHaveBeenCalledTimes(1);
        expect(runFn).toHaveBeenCalledWith('item-primary');
        expect(router).toHaveBeenCalledTimes(2);
      },
    );

    it('succeeds when own property shadows an Object.prototype key', async () => {
      const items = {toString: 'custom-to-string'};
      const context: Context = {requestId: 'req-shadow'};
      const router: Router<string, Context> = () => 'toString';

      const results = await collectAsync(
        runWithRouting(items, context, router, async (item) => item),
      );

      expect(results).toEqual(['custom-to-string']);
    });

    it('works with null-prototype items for present and missing keys', async () => {
      const items = Object.assign(
        Object.create(null) as Record<string, string>,
        {a: 'nullProtoItem'},
      );
      const context: Context = {requestId: 'req-null-proto'};

      const routerPresent: Router<string, Context> = () => 'a';
      const results = await collectAsync(
        runWithRouting(items, context, routerPresent, async (item) => item),
      );
      expect(results).toEqual(['nullProtoItem']);

      const routerMissing: Router<string, Context> = () => 'missing';
      await expect(
        collectAsync(
          runWithRouting(items, context, routerMissing, async (item) => item),
        ),
      ).rejects.toThrow('Item not found for key: missing');
    });

    it('rejects own property with undefined value on initial routing', async () => {
      const items: Record<string, string> = {a: undefined as unknown as string};
      const context: Context = {requestId: 'req-undef-init'};
      const router = vi.fn<Router<string, Context>>().mockReturnValue('a');
      const runFn = vi.fn().mockResolvedValue('ok');

      await expect(
        collectAsync(runWithRouting(items, context, router, runFn)),
      ).rejects.toThrow('Item not found for key: a');

      expect(runFn).not.toHaveBeenCalled();
      expect(router).toHaveBeenCalledTimes(1);
    });

    it('rejects own property with undefined value on failover', async () => {
      const items: Record<string, string> = {
        primary: 'primary-item',
        fallback: undefined as unknown as string,
      };
      const context: Context = {requestId: 'req-undef-failover'};
      const router = vi
        .fn<Router<string, Context>>()
        .mockReturnValueOnce('primary')
        .mockReturnValueOnce('fallback');
      const runFn = vi.fn(async (item: string) => {
        if (item === 'primary-item') {
          throw new Error('primary failed');
        }
        return item;
      });

      await expect(
        collectAsync(runWithRouting(items, context, router, runFn)),
      ).rejects.toThrow('Item not found for key: fallback');

      expect(runFn).toHaveBeenCalledTimes(1);
      expect(runFn).toHaveBeenCalledWith('primary-item');
      expect(router).toHaveBeenCalledTimes(2);
    });
  });

  describe('falsy values and null handling', () => {
    it.each([
      {type: 'number 0', value: 0},
      {type: 'empty string', value: ''},
      {type: 'boolean false', value: false},
      {type: 'null', value: null},
    ])(
      'succeeds with falsy own property value ($type) on initial routing',
      async ({value}) => {
        const items = {key: value};
        const context: Context = {requestId: 'req-falsy-init'};
        const router: Router<unknown, Context> = () => 'key';
        const runFn = vi.fn(async (item: unknown) => item);

        const results = await collectAsync(
          runWithRouting(items, context, router, runFn),
        );

        expect(results).toEqual([value]);
        expect(runFn).toHaveBeenCalledWith(value);
      },
    );

    it.each([
      {type: 'number 0', primary: 99, fallback: 0},
      {type: 'empty string', primary: 'initial', fallback: ''},
      {type: 'boolean false', primary: true, fallback: false},
      {type: 'null', primary: 'initial', fallback: null},
    ])(
      'succeeds with falsy own property value ($type) on failover',
      async ({primary, fallback}) => {
        const items: Record<string, unknown> = {
          primary,
          fallback,
        };
        const context: Context = {requestId: 'req-falsy-failover'};
        const router = vi
          .fn<Router<unknown, Context>>()
          .mockReturnValueOnce('primary')
          .mockReturnValueOnce('fallback');
        const runFn = vi.fn(async (item: unknown) => {
          if (item === primary) {
            throw new Error('primary failed');
          }
          return item;
        });

        const results = await collectAsync(
          runWithRouting(items, context, router, runFn),
        );

        expect(results).toEqual([fallback]);
        expect(runFn).toHaveBeenCalledTimes(2);
        expect(runFn).toHaveBeenNthCalledWith(1, primary);
        expect(runFn).toHaveBeenNthCalledWith(2, fallback);
      },
    );

    it('yields null when runFn returns Promise<null>', async () => {
      const items = {a: 'itemA'};
      const context: Context = {requestId: 'req-null-promise'};
      const router = vi.fn<Router<string, Context>>().mockReturnValue('a');

      const results = await collectAsync(
        runWithRouting(items, context, router, async () => null),
      );

      expect(results).toEqual([null]);
      expect(router).toHaveBeenCalledTimes(1);
    });

    it('yields null when runFn returns synchronous null', async () => {
      const items = {a: 'itemA'};
      const context: Context = {requestId: 'req-null-sync'};
      const router = vi.fn<Router<string, Context>>().mockReturnValue('a');

      const results = await collectAsync(
        runWithRouting(
          items,
          context,
          router,
          () => null as unknown as Promise<null>,
        ),
      );

      expect(results).toEqual([null]);
      expect(router).toHaveBeenCalledTimes(1);
    });
  });
});
