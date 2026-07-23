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
  const suffix = `\n... (truncated to ${str.length} chars)`;
  return str.substring(0, limit) + suffix;
}

/**
 * Validates and resolves a path against a base working directory, ensuring
 * that the resolved path does not escape the working directory.
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
