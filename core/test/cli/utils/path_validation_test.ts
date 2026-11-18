/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import {
  isStrictlyInside,
  validatePathSegment,
} from '../../../src/cli/utils/path_validation.js';

describe('validatePathSegment', () => {
  it.each([undefined, null, 123, {}])(
    'throws InputValidationError for the non-string value %j',
    (value) => {
      expect(() =>
        validatePathSegment(value as unknown as string, 'appName'),
      ).toThrow(new InputValidationError('appName must not be empty.'));
    },
  );

  it('accepts a plain name', () => {
    expect(() => validatePathSegment('my_agent', 'appName')).not.toThrow();
  });
});

describe('isStrictlyInside', () => {
  const baseDir = path.resolve('/base');

  it.each([
    ['a direct child', path.join(baseDir, 'child'), true],
    ['a nested child', path.join(baseDir, 'a', 'b'), true],
    ['a child that starts with two dots', path.join(baseDir, '..child'), true],
    ['the base directory itself', baseDir, false],
    ['the parent directory', path.dirname(baseDir), false],
    ['a sibling directory', path.resolve('/base_sibling'), false],
    ['a path outside through ..', path.resolve(baseDir, '../other'), false],
  ])('returns the expected result for %s', (_label, target, expected) => {
    expect(isStrictlyInside(baseDir, target)).toBe(expected);
  });
});
