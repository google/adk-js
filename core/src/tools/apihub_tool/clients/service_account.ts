/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parses a service account key from its JSON text.
 *
 * @throws `Invalid service account JSON: ...` when `json` does not parse.
 */
export function parseServiceAccountJson(json: string): Record<string, string> {
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid service account JSON: ${message}`, {cause: e});
  }
}
