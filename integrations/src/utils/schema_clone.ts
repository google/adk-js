/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Non-JSON object instances (e.g., Date, Map, RegExp) become {} here, which is expected for JSON Schema objects carrying non-clonable validator functions/symbols.
function clonePlainValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (Array.isArray(value)) {
    const clonedArray: unknown[] = [];
    seen.set(value, clonedArray);
    for (const item of value) {
      if (typeof item === 'function' || typeof item === 'symbol') {
        clonedArray.push(undefined);
      } else {
        clonedArray.push(clonePlainValue(item, seen));
      }
    }
    return clonedArray;
  }
  const clonedRecord: Record<string, unknown> = {};
  seen.set(value, clonedRecord);
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === 'function' || typeof entryValue === 'symbol') {
      continue;
    }
    clonedRecord[key] = clonePlainValue(entryValue, seen);
  }
  return clonedRecord;
}

/**
 * Clones a JSON Schema record so caller mutations do not affect the source.
 */
export function cloneSchemaRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return structuredClone(record);
  } catch {
    return clonePlainValue(record) as Record<string, unknown>;
  }
}
