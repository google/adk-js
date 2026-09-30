/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for deriving a short, stable identifier from an arbitrary value, so
 * that structurally equal values map to the same cache slot and different
 * values do not.
 */

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Serializes `value` to JSON with the keys of every object sorted, so two
 * structurally equal values stringify identically whatever order their
 * properties were assigned in.
 *
 * Array order is meaningful and is preserved. A value JSON cannot represent at
 * the top level, such as `undefined` or a function, stringifies to
 * `'undefined'`, because `JSON.stringify` returns no string for it and callers
 * need one.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? 'undefined';
}

/**
 * Returns a short lowercase hex digest of `value`, computed with FNV-1a over
 * {@link stableStringify}.
 *
 * This is not a cryptographic hash and must not be used as one. It exists to
 * keep distinct values in distinct cache slots, which is the same job
 * adk-python gives the builtin `hash()`.
 */
export function stableHash(value: unknown): string {
  const text = stableStringify(value);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32-bit space, which `*` does not.
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Rebuilds `value` with the keys of every plain object in sorted order,
 * leaving arrays and primitives as they are.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortKeysDeep(source[key]);
  }
  return sorted;
}
