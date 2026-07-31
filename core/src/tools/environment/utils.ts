/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Truncate a string to a max length, adding a suffix if truncated.
 * @param str The string to truncate.
 * @param limit The maximum number of characters.
 * @return The truncated string.
 */
export function truncate(str: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }
  if (str.length <= limit) {
    return str;
  }
  const suffix = `\n... (truncated, ${str.length} total chars)`;
  return str.substring(0, limit) + suffix;
}

/**
 * Narrows a caught value to an `Error`, wrapping anything else.
 *
 * `catch` binds `unknown` because any value can be thrown. Node rejects with
 * `Error` subtypes whose extra fields are all optional, such as
 * `child_process.ExecException`, so the result of this function can be
 * assigned straight to one of those without a type assertion.
 *
 * @param e The caught value.
 * @return `e` itself when it is an `Error`, otherwise a new `Error` describing
 *     it.
 */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Whether a caught value is Node's "no such file or directory" system error.
 *
 * `fs/promises` rejects with an `Error` carrying a string `code`. The property
 * is checked at runtime rather than asserted, because the ambient
 * `NodeJS.ErrnoException` type is not usable here: it has no runtime binding
 * and the lint config's `no-undef` rejects the `NodeJS` namespace.
 *
 * @param e The caught value.
 * @return Whether `e` reports `ENOENT`.
 */
export function isFileNotFoundError(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT';
}
