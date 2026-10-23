/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  codePointLength,
  exceedsCodePoints,
  lastCodePoints,
  parseQueryPairs,
  sliceCodePoints,
  urlSplit,
  urlUnsplit,
} from '../../src/bigquery_analytics/python_strings.js';

// Expected values are CPython 3.14 `urllib.parse` and `str` slicing output.

describe('urlSplit and urlUnsplit', () => {
  it.each([
    'file:///tmp/report.pdf',
    'http:foo',
    'http://[::1]:8080/path?q=1#frag',
    'gs://bucket/object',
    'x:////a',
    '//host/path',
    'mailto:a@b',
  ])('round-trips %s', (url) => {
    expect(urlUnsplit(urlSplit(url))).toBe(url);
  });

  it.each([
    ['http:', 'http://'],
    ['file:', 'file://'],
    ['http:/p', 'http:///p'],
  ])('adds the empty authority of a netloc scheme to %s', (url, expected) => {
    expect(urlUnsplit(urlSplit(url))).toBe(expected);
  });

  it('splits an IPv6 host and rejects an unbalanced bracket', () => {
    expect(urlSplit('http://[::1]:8080/p').netloc).toBe('[::1]:8080');
    expect(() => urlSplit('http://[::1/p')).toThrow(RangeError);
  });
});

describe('parseQueryPairs', () => {
  it('keeps characters outside the BMP whole', () => {
    expect(parseQueryPairs('q=😀&a=%F0%9F%98%80+x&k')).toEqual([
      ['q', '😀'],
      ['a', '😀 x'],
      ['k', ''],
    ]);
  });
});

describe('code point helpers', () => {
  it('count and slice code points, not UTF-16 units', () => {
    expect(codePointLength('😀a')).toBe(2);
    expect(exceedsCodePoints('😀a', 2)).toBe(false);
    expect(exceedsCodePoints('😀ab', 2)).toBe(true);
    expect(exceedsCodePoints('😀ab', -1)).toBe(false);
    expect(sliceCodePoints('😀😀a', 1)).toBe('😀');
    expect(lastCodePoints('a😀😀', 1)).toBe('😀');
    expect(lastCodePoints('a😀', 5)).toBe('a😀');
  });
});
