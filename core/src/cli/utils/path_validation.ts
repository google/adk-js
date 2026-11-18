/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

import {InputValidationError} from '../../errors/input_validation_error.js';

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/**
 * Validates that a caller-supplied identifier is a safe single path segment and
 * cannot traverse directories.
 *
 * This is a lexical check on the string only. It does not resolve symlinks and
 * is not a sandbox.
 *
 * @param value The caller-supplied identifier. Non-string values are rejected.
 * @param fieldName Human-readable field name used in error messages.
 * @throws {InputValidationError} If `value` is not a non-empty string, or if it
 *     contains a null byte, a path separator, a drive prefix, or is `.` or `..`.
 */
export function validatePathSegment(value: string, fieldName: string): void {
  if (typeof value !== 'string' || !value) {
    throw new InputValidationError(`${fieldName} must not be empty.`);
  }
  if (value.includes('\x00')) {
    throw new InputValidationError(`${fieldName} must not contain null bytes.`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new InputValidationError(
      `${fieldName} '${value}' must not contain path separators.`,
    );
  }
  if (WINDOWS_DRIVE_RE.test(value)) {
    throw new InputValidationError(
      `${fieldName} '${value}' must not be drive-qualified.`,
    );
  }
  if (value === '.' || value === '..') {
    throw new InputValidationError(
      `${fieldName} '${value}' must not contain traversal segments.`,
    );
  }
}

/**
 * Returns whether `target` is lexically inside `baseDir` and is not `baseDir`
 * itself.
 *
 * Both paths should already be absolute. This compares strings after
 * `path.relative`. It does not follow symlinks and is not a sandbox.
 *
 * @param baseDir The absolute directory that must contain `target`.
 * @param target The absolute path to check.
 * @returns `true` if `target` is a strict descendant of `baseDir`.
 */
export function isStrictlyInside(baseDir: string, target: string): boolean {
  const rel = path.relative(baseDir, target);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}
