/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';

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

/**
 * Validates and resolves a path against a base working directory, ensuring
 * that the resolved path does not escape the working directory.
 *
 * The check is lexical: `path.resolve` and `path.relative` normalize `..`
 * segments but never touch the filesystem, so a symlink stored inside
 * `workingDir` that points elsewhere still resolves to a path outside it. That
 * is deliberate -- reading through symlinks is normal and necessary for real
 * workspace layouts, such as the package links npm creates under
 * `node_modules`. This guards against traversal in the *argument*; it is not a
 * sandbox, and callers who need one should point the tools at an isolated
 * filesystem.
 *
 * @param workingDir The base working directory.
 * @param relativeOrAbsolutePath The path to check.
 * @return The resolved absolute path.
 */
export function resolveAndValidatePath(
  workingDir: string,
  relativeOrAbsolutePath: string,
): string {
  // If it's absolute, check it directly. Otherwise resolve relative to workingDir
  const resolvedWorkingDir = path.resolve(workingDir);
  const resolvedPath = path.resolve(resolvedWorkingDir, relativeOrAbsolutePath);
  const relative = path.relative(resolvedWorkingDir, resolvedPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Path ${relativeOrAbsolutePath} escapes the working directory.`,
    );
  }
  return resolvedPath;
}
