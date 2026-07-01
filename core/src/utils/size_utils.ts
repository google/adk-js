/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Estimates the size of a value in characters.
 * Returns length for strings, or stringified JSON length for objects.
 */
export function getResponseSize(value: unknown): number {
  try {
    return typeof value === 'string'
      ? value.length
      : (JSON.stringify(value)?.length ?? 0);
  } catch {
    return 0;
  }
}
