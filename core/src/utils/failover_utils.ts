/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definition for a function that selects an item based on the context.
 */
export type Router<T, C> = (
  items: Readonly<Record<string, T>>,
  context: C,
  errorContext?: {failedKeys: ReadonlySet<string>; lastError: unknown},
) => Promise<string | undefined> | string | undefined;

/**
 * Runs a core operation with selection and failover support.
 * Internal helper to unify Promise and Generator logic.
 */
async function* runWithRoutingCore<T, C, TYield, TReturn>(
  items: Readonly<Record<string, T>>,
  context: C,
  router: Router<T, C>,
  runFn: (item: T) => AsyncGenerator<TYield, TReturn, void> | Promise<TReturn>,
): AsyncGenerator<TYield, TReturn> {
  const initialKey = await router(items, context);
  if (!initialKey) {
    throw new Error('Initial routing failed, no item selected.');
  }

  let selectedKey = initialKey;
  let selectedItem = items[selectedKey];
  if (!selectedItem) {
    throw new Error(`Item not found for key: ${selectedKey}`);
  }

  const triedKeys = new Set<string>([selectedKey]);

  while (true) {
    const runResult = runFn(selectedItem);
    let firstYielded = false;

    try {
      if (
        runResult &&
        typeof runResult === 'object' &&
        typeof (runResult as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
          'function'
      ) {
        const iterator = runResult as AsyncGenerator<TYield, TReturn, void>;
        while (true) {
          const result = await iterator.next();
          if (result.done) {
            return result.value;
          }
          yield result.value;
          firstYielded = true;
        }
      } else {
        return await (runResult as Promise<TReturn>);
      }
    } catch (error) {
      if (!firstYielded) {
        const nextKey = await router(items, context, {
          failedKeys: triedKeys,
          lastError: error,
        });

        // Router can return undefined to stop processing
        if (!nextKey) {
          throw error;
        }

        // Disallow re-processing the same key in a single execution
        if (triedKeys.has(nextKey)) {
          throw error;
        }

        selectedKey = nextKey;
        selectedItem = items[selectedKey];
        if (!selectedItem) {
          throw new Error(`Item not found for key: ${selectedKey}`);
        }
        triedKeys.add(selectedKey);
      } else {
        throw error;
      }
    }
  }
}

/**
 * Runs an operation with selection and failover support.
 * Overloaded to support both AsyncGenerator and Promise-returning functions.
 */
export function runWithRouting<T, C, R>(
  items: Readonly<Record<string, T>>,
  context: C,
  router: Router<T, C>,
  runFn: (item: T) => AsyncGenerator<R, void, void>,
): AsyncGenerator<R, void>;

// eslint-disable-next-line no-redeclare
export function runWithRouting<T, C, R>(
  items: Readonly<Record<string, T>>,
  context: C,
  router: Router<T, C>,
  runFn: (item: T) => Promise<R>,
): Promise<R>;

// eslint-disable-next-line no-redeclare
export function runWithRouting<T, C, R>(
  items: Readonly<Record<string, T>>,
  context: C,
  router: Router<T, C>,
  runFn: (item: T) => AsyncGenerator<R, void, void> | Promise<R>,
): unknown {
  const gen = runWithRoutingCore(items, context, router, runFn);

  return {
    then<TResult1 = R, TResult2 = never>(
      onfulfilled?: ((value: R) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): Promise<TResult1 | TResult2> {
      const p = (async () => {
        while (true) {
          const result = await gen.next();
          if (result.done) {
            return result.value as R;
          }
        }
      })();
      return p.then(onfulfilled, onrejected);
    },

    [Symbol.asyncIterator](): AsyncIterator<R, void> {
      return gen as unknown as AsyncIterator<R, void>;
    },
  };
}
