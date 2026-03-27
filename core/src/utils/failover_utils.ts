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
 * Runs a generator-based operation with selection and failover support.
 */
export async function* runWithSelectionAndFailoverGenerator<T, C, R>(
  items: Readonly<Record<string, T>>,
  context: C,
  router: Router<T, C>,
  runFn: (item: T) => AsyncGenerator<R, void, void>,
): AsyncGenerator<R, void> {
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
    const iterator = runFn(selectedItem);
    let firstYielded = false;

    try {
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        yield result.value;
        firstYielded = true;
      }
      break; // Success!
    } catch (error) {
      if (!firstYielded) {
        const nextKey = await router(items, context, {
          failedKeys: triedKeys,
          lastError: error,
        });

        if (!nextKey) {
          throw error; // Router decided to bail out
        }

        if (triedKeys.has(nextKey)) {
          throw error; // Give up to avoid infinite loop
        }

        selectedKey = nextKey;
        selectedItem = items[selectedKey];
        if (!selectedItem) {
          throw new Error(`Item not found for key: ${selectedKey}`);
        }
        triedKeys.add(selectedKey);
      } else {
        throw error; // Re-throw if data was already yielded
      }
    }
  }
}

/**
 * Runs a promise-based operation with selection and failover support.
 */
export async function runWithSelectionAndFailoverPromise<T, C, R>(
  items: Readonly<Record<string, T>>,
  context: C,
  router: Router<T, C>,
  runFn: (item: T) => Promise<R>,
): Promise<R> {
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
    try {
      return await runFn(selectedItem);
    } catch (error) {
      const nextKey = await router(items, context, {
        failedKeys: triedKeys,
        lastError: error,
      });

      if (!nextKey) {
        throw error; // Router decided to bail out
      }

      if (triedKeys.has(nextKey)) {
        throw error; // Give up to avoid infinite loop
      }

      selectedKey = nextKey;
      selectedItem = items[selectedKey];
      if (!selectedItem) {
        throw new Error(`Item not found for key: ${selectedKey}`);
      }
      triedKeys.add(selectedKey);
    }
  }
}
