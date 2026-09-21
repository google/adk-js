/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {stableHash, stableStringify} from '../../src/utils/hash_utils.js';

describe('stableStringify', () => {
  it('sorts top-level keys, so assignment order does not matter', () => {
    expect(stableStringify({a: 1, b: 2})).toBe(stableStringify({b: 2, a: 1}));
    expect(stableStringify({b: 2, a: 1})).toBe('{"a":1,"b":2}');
  });

  it('sorts keys of nested objects too', () => {
    expect(stableStringify({outer: {z: 1, a: {y: 2, b: 3}}})).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  it('keeps array order, which is meaningful', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(stableStringify([3, 1, 2])).not.toBe(stableStringify([1, 2, 3]));
  });

  it('sorts the keys of objects inside an array', () => {
    expect(stableStringify([{b: 1, a: 2}])).toBe('[{"a":2,"b":1}]');
  });

  it('passes primitives and null through', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(7)).toBe('7');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(true)).toBe('true');
  });

  it('returns a string for a value JSON cannot represent', () => {
    // JSON.stringify returns undefined for these, and stableHash needs a
    // string to iterate over.
    expect(stableStringify(undefined)).toBe('undefined');
    expect(stableStringify(() => 1)).toBe('undefined');
  });
});

describe('stableHash', () => {
  it('gives structurally equal values the same digest', () => {
    expect(stableHash({a: 1, b: {c: 2}})).toBe(stableHash({b: {c: 2}, a: 1}));
  });

  it('gives distinct values distinct digests', () => {
    const digests = new Set([
      stableHash({type: 'apiKey', name: 'X-Api-Key'}),
      stableHash({type: 'apiKey', name: 'X-Other-Key'}),
      stableHash({type: 'http'}),
      stableHash(''),
    ]);
    expect(digests.size).toBe(4);
  });

  it('returns lowercase hexadecimal', () => {
    expect(stableHash({a: 1})).toMatch(/^[0-9a-f]+$/);
  });

  it('does not throw on a value JSON cannot represent', () => {
    expect(stableHash(undefined)).toMatch(/^[0-9a-f]+$/);
  });
});
