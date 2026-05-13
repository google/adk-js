/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Copies a set of keys from one object to another.
 *
 * @param source The source object.
 * @param targetKeys The keys to copy.
 * @returns A new object with the specified keys copied from source.
 */
export function partialCopy<TDest extends object>(
  source: object,
  targetKeys: (keyof TDest)[],
): TDest {
  const result = {} as TDest;
  const sourceAsUnknown = source as Record<string, unknown>;

  targetKeys.forEach((key) => {
    const keyStr = key as string;
    if (keyStr in source) {
      result[key] = sourceAsUnknown[keyStr] as TDest[typeof key];
    } else {
      result[key] = undefined as unknown as TDest[typeof key];
    }
  });

  return result;
}
