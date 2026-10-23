/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  pythonJsonDumps,
  pythonJsonLoads,
} from '../../src/bigquery_analytics/python_json.js';

// Expected strings are CPython 3 `json.dumps(json.loads(text))` output.

function roundTrip(text: string): string {
  return pythonJsonDumps(pythonJsonLoads(text).value);
}

describe('pythonJsonLoads and pythonJsonDumps', () => {
  it.each([
    ['9007199254740993', '9007199254740993'],
    ['-9007199254740993', '-9007199254740993'],
    ['12345678901234567890', '12345678901234567890'],
    ['9007199254740991', '9007199254740991'],
    ['-0', '0'],
    ['2.0', '2.0'],
    ['1.0', '1.0'],
    ['-0.0', '-0.0'],
    ['1E+2', '100.0'],
    ['1e15', '1000000000000000.0'],
    ['1e16', '1e+16'],
    ['1e22', '1e+22'],
    ['1e-4', '0.0001'],
    ['9e-5', '9e-05'],
    ['5e-324', '5e-324'],
    ['0.1', '0.1'],
    ['1.5e300', '1.5e+300'],
    ['1e400', 'Infinity'],
  ])('keeps the number %s as Python prints it', (text, expected) => {
    expect(roundTrip(text)).toBe(expected);
  });

  it('keeps 64-bit integers and float lexemes inside documents', () => {
    expect(
      roundTrip(
        '{"a": [1.0, -0, 1E+2, 9007199254740993, -9007199254740993, 1e400]}',
      ),
    ).toBe(
      '{"a": [1.0, 0, 100.0, 9007199254740993, -9007199254740993, Infinity]}',
    );
  });

  it('keeps the last duplicate at the first position', () => {
    const document = pythonJsonLoads(
      '{"id": 9007199254740993, "x": 1, "id": 2.0}',
    );
    expect(document.sawDuplicateKey).toBe(true);
    expect(pythonJsonDumps(document.value)).toBe('{"id": 2.0, "x": 1}');
  });

  it('escapes non-ASCII as UTF-16 escapes, surrogate pairs included', () => {
    const escaped = String.raw`"\ud83d\ude00\u00e9\u0000"`;
    expect(pythonJsonDumps('\u{1F600}\u00e9\u0000')).toBe(escaped);
    expect(roundTrip(escaped)).toBe(escaped);
  });
});
