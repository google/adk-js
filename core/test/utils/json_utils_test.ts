/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isJsonObject, toJsonObject} from '../../src/utils/json_utils.js';

describe('isJsonObject', () => {
  it('returns true for plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({a: 1, nested: {b: 'two'}})).toBe(true);
  });

  it('returns false for null, arrays, and primitives', () => {
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(['a'])).toBe(false);
    expect(isJsonObject(' {} ')).toBe(false);
    expect(isJsonObject(42)).toBe(false);
    expect(isJsonObject(true)).toBe(false);
  });
});

describe('toJsonObject', () => {
  it('returns the same object when the input is a JSON object', () => {
    const input = {key: 'value'};
    expect(toJsonObject(input)).toBe(input);
  });

  it('returns an empty object for non-object inputs', () => {
    expect(toJsonObject(null)).toEqual({});
    expect(toJsonObject(undefined)).toEqual({});
    expect(toJsonObject([1, 2])).toEqual({});
    expect(toJsonObject('text')).toEqual({});
    expect(toJsonObject(123)).toEqual({});
  });
});
