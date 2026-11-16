/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CIRCULAR_REFERENCE,
  MAX_DEPTH_EXCEEDED,
  MAX_SANITIZE_DEPTH,
  objectTag,
  ownEntries,
} from './sanitize.js';

/** Converts a camelCase or PascalCase key to snake_case, keeping acronyms. */
export function camelToSnake(key: string): string {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

// SDK models are plain objects, arrays or class instances without a
// `Symbol.toStringTag`; built-ins such as URL, Error or boxed primitives pass
// through for the sanitizer to render.
function isSdkContainer(value: object): boolean {
  try {
    const tag = objectTag(value);
    return tag === '[object Object]' || tag === '[object Array]';
  } catch {
    return false;
  }
}

/**
 * Deep-converts camelCase object keys to snake_case, the key style adk-python's
 * `model_dump()` gives SDK models. For SDK structures only (usage and cache
 * metadata); user dictionaries such as tool arguments and session state must
 * keep their keys.
 *
 * A key whose snake_case form another key already has keeps its own spelling,
 * so no entry is lost.
 */
export function snakeCaseKeysDeep(value: unknown): unknown {
  return snakeCaseNode(value, new Set(), 0);
}

function snakeCaseNode(
  node: unknown,
  inProgress: Set<object>,
  depth: number,
): unknown {
  if (typeof node !== 'object' || node === null || !isSdkContainer(node)) {
    return node;
  }
  if (inProgress.has(node)) {
    return CIRCULAR_REFERENCE;
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return MAX_DEPTH_EXCEEDED;
  }
  inProgress.add(node);
  try {
    if (Array.isArray(node)) {
      return node.map((item: unknown) =>
        snakeCaseNode(item, inProgress, depth + 1),
      );
    }
    const entries = ownEntries(node).filter(({accessor}) => !accessor);
    const taken = new Set(
      entries.map(({key}) => key).filter((key) => camelToSnake(key) === key),
    );
    const out: Record<string, unknown> = {};
    for (const {key, value: child} of entries) {
      let outKey = camelToSnake(key);
      if (outKey !== key) {
        outKey = taken.has(outKey) ? key : outKey;
        taken.add(outKey);
      }
      Object.defineProperty(out, outKey, {
        value: snakeCaseNode(child, inProgress, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    inProgress.delete(node);
  }
}
