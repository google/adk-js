/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CIRCULAR_REFERENCE, isBytes, ownEntries} from './sanitize.js';

function camelToSnake(key: string): string {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function isSdkContainer(value: object): boolean {
  return (
    !(value instanceof Date) &&
    !ArrayBuffer.isView(value) &&
    !isBytes(value) &&
    !(value instanceof Map) &&
    !(value instanceof Set) &&
    !(value instanceof RegExp) &&
    !(value instanceof Error) &&
    !(value instanceof Promise)
  );
}

/**
 * Deep-converts camelCase object keys to snake_case, the key style adk-python's
 * `model_dump()` gives SDK models. For SDK structures only (usage and cache
 * metadata); user dictionaries such as tool arguments and session state must
 * keep their keys.
 */
export function snakeCaseKeysDeep(value: unknown): unknown {
  return snakeCaseNode(value, new Set());
}

function snakeCaseNode(node: unknown, inProgress: Set<object>): unknown {
  if (typeof node !== 'object' || node === null || !isSdkContainer(node)) {
    return node;
  }
  if (inProgress.has(node)) {
    return CIRCULAR_REFERENCE;
  }
  inProgress.add(node);
  try {
    if (Array.isArray(node)) {
      return node.map((item: unknown) => snakeCaseNode(item, inProgress));
    }
    const out: Record<string, unknown> = {};
    for (const {key, value: child, accessor} of ownEntries(node)) {
      if (!accessor) {
        Object.defineProperty(out, camelToSnake(key), {
          value: snakeCaseNode(child, inProgress),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  } finally {
    inProgress.delete(node);
  }
}
