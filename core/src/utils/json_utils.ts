/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A JSON object keyed by string. */
export type JsonObject = Record<string, unknown>;

/** Narrows an arbitrary value to a plain JSON object (non-null, non-array). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns `value` when it is a JSON object, or `{}` otherwise. */
export function toJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}
