/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';

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
export async function* runWithRouting<T, C, TYield>(
  items: Readonly<Record<string, T>>,
  context: C,
  router: Router<T, C>,
  runFn: (item: T) => AsyncGenerator<TYield, void, void> | Promise<TYield>,
): AsyncGenerator<TYield, void, void> {
  const initialKey = await router(items, context);
  if (!initialKey) {
    throw new Error('Initial routing failed, no item selected.');
  }

  let selectedKey = initialKey;
  logger.debug(`Router selected initial key: ${selectedKey}`);
  let selectedItem = items[selectedKey];
  if (!selectedItem) {
    throw new Error(`Item not found for key: ${selectedKey}`);
  }

  const triedKeys = new Set<string>([selectedKey]);

  while (true) {
    const generatorOrPromise = runFn(selectedItem);
    let firstYielded = false;

    try {
      if (isAsyncGenerator(generatorOrPromise)) {
        for await (const result of generatorOrPromise) {
          yield result;
          firstYielded = true;
        }
        return;
      }

      const result = await generatorOrPromise;
      yield result;
      return;
    } catch (error) {
      if (!firstYielded) {
        const nextKey = await router(items, context, {
          failedKeys: triedKeys,
          lastError: error,
        });

        logger.debug(`Router selected next key: ${nextKey}`);

        // Router can return undefined to stop processing
        if (nextKey === undefined) {
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

function isAsyncGenerator(
  obj: unknown,
): obj is AsyncGenerator<unknown, void, void> {
  return (
    typeof obj === 'object' &&
    typeof (obj as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}
