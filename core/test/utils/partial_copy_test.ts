/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {partialCopy} from '../../src/utils/partial_copy.js';

interface SampleDest {
  a: string;
  b: number;
  c?: boolean;
}

describe('partialCopy', () => {
  it('should copy specified keys from source to new object', () => {
    const source = {a: 'hello', b: 42, c: true, d: 'extra'};
    const result = partialCopy<SampleDest>(source, ['a', 'b']);

    expect(result.a).toBe('hello');
    expect(result.b).toBe(42);
    expect('d' in result).toBe(false);
  });

  it('should set key to undefined if not present in source', () => {
    const source = {a: 'hello'};
    const result = partialCopy<SampleDest>(source, ['a', 'b']);

    expect(result.a).toBe('hello');
    expect(result.b).toBeUndefined();
  });

  it('should return empty object when targetKeys is empty', () => {
    const source = {a: 'hello', b: 42};
    const result = partialCopy<SampleDest>(source, []);

    expect(Object.keys(result)).toHaveLength(0);
  });

  it('should copy all specified keys including optional ones', () => {
    const source = {a: 'hello', b: 42, c: false};
    const result = partialCopy<SampleDest>(source, ['a', 'b', 'c']);

    expect(result.a).toBe('hello');
    expect(result.b).toBe(42);
    expect(result.c).toBe(false);
  });

  it('should not mutate the source object', () => {
    const source = {a: 'hello', b: 42};
    const original = {...source};
    partialCopy<SampleDest>(source, ['a', 'b']);

    expect(source).toEqual(original);
  });

  it('should copy falsy values correctly', () => {
    const source = {a: '', b: 0, c: false};
    const result = partialCopy<SampleDest>(source, ['a', 'b', 'c']);

    expect(result.a).toBe('');
    expect(result.b).toBe(0);
    expect(result.c).toBe(false);
  });

  it('should return a new object, not the same reference', () => {
    const source = {a: 'hello', b: 42};
    const result = partialCopy<SampleDest>(source, ['a', 'b']);

    expect(result).not.toBe(source);
  });
});
