/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type JsonValue} from './types.js';

// Python's `json` module is the reference serializer for every string
// adk-python writes to BigQuery (re-serialized blobs, JSON-form map keys).
// These helpers reproduce `json.loads` / `json.dumps` defaults so the
// TypeScript port emits byte-identical text.

const MAX_NESTING_DEPTH = 1000;
// CPython's default `sys.int_max_str_digits`: longer integer literals raise
// ValueError in json.loads.
const MAX_INT_DIGITS = 4300;

/**
 * `json.loads` raised ValueError (malformed document, extra data, oversized
 * integer).
 */
export class PythonJsonSyntaxError extends Error {
  override readonly name = 'PythonJsonSyntaxError';
}

/** `json.loads` raised RecursionError. */
export class PythonJsonDepthError extends Error {
  override readonly name = 'PythonJsonDepthError';
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

const ESCAPES = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

function defineKey(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

class Parser {
  index = 0;
  sawDuplicateKey = false;

  constructor(private readonly text: string) {}

  private fail(message: string): never {
    throw new PythonJsonSyntaxError(`${message}: char ${this.index}`);
  }

  skipWhitespace(): void {
    while (
      this.index < this.text.length &&
      WHITESPACE.has(this.text.charAt(this.index))
    ) {
      this.index += 1;
    }
  }

  parseValue(depth: number): JsonValue {
    const char = this.text.charAt(this.index);
    if (char === '"') {
      return this.parseString();
    }
    if (char === '{' || char === '[') {
      if (depth >= MAX_NESTING_DEPTH) {
        throw new PythonJsonDepthError(
          'maximum recursion depth exceeded while decoding a JSON document',
        );
      }
      return char === '{'
        ? this.parseObject(depth + 1)
        : this.parseArray(depth + 1);
    }
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ] as const) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(
      this.text.slice(this.index),
    );
    if (match === null) {
      this.fail('Expecting value');
    }
    const literal = match[0];
    const isInteger = match[1] === undefined && match[2] === undefined;
    if (isInteger && literal.replace('-', '').length > MAX_INT_DIGITS) {
      this.fail('Exceeds the limit for integer string conversion');
    }
    this.index += literal.length;
    return Number(literal);
  }

  parseString(): string {
    this.index += 1;
    let out = '';
    let chunkStart = this.index;
    while (this.index < this.text.length) {
      const char = this.text.charAt(this.index);
      if (char === '"') {
        out += this.text.slice(chunkStart, this.index);
        this.index += 1;
        return out;
      }
      if (char === '\\') {
        out += this.text.slice(chunkStart, this.index);
        const escape = this.text.charAt(this.index + 1);
        if (escape === 'u') {
          const hex = this.text.slice(this.index + 2, this.index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail(String.raw`Invalid \uXXXX escape`);
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 6;
        } else {
          const decoded = ESCAPES.get(escape);
          if (decoded === undefined) {
            this.fail(String.raw`Invalid \escape`);
          }
          out += decoded;
          this.index += 2;
        }
        chunkStart = this.index;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) {
        this.fail('Invalid control character');
      }
      this.index += 1;
    }
    return this.fail('Unterminated string starting at');
  }

  private parseObject(depth: number): JsonValue {
    this.index += 1;
    const result: Record<string, JsonValue> = {};
    this.skipWhitespace();
    if (this.text.charAt(this.index) === '}') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text.charAt(this.index) !== '"') {
        this.fail('Expecting property name enclosed in double quotes');
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text.charAt(this.index) !== ':') {
        this.fail("Expecting ':' delimiter");
      }
      this.index += 1;
      this.skipWhitespace();
      const value = this.parseValue(depth);
      if (Object.hasOwn(result, key)) {
        this.sawDuplicateKey = true;
      }
      defineKey(result, key, value);
      this.skipWhitespace();
      const next = this.text.charAt(this.index);
      this.index += 1;
      if (next === '}') {
        return result;
      }
      if (next !== ',') {
        this.fail("Expecting ',' delimiter");
      }
    }
  }

  private parseArray(depth: number): JsonValue {
    this.index += 1;
    const result: Array<JsonValue> = [];
    this.skipWhitespace();
    if (this.text.charAt(this.index) === ']') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const next = this.text.charAt(this.index);
      this.index += 1;
      if (next === ']') {
        return result;
      }
      if (next !== ',') {
        this.fail("Expecting ',' delimiter");
      }
    }
  }
}

/**
 * `json.loads`, also reporting whether any object repeated a member name
 * (Python's `object_pairs_hook` view): the parsed value keeps only the last
 * duplicate.
 */
/** A decoded document, and whether any object in it repeated a member name. */
export interface PythonJsonDocument {
  value: JsonValue;
  sawDuplicateKey: boolean;
}

export function pythonJsonLoads(text: string): PythonJsonDocument {
  const parser = new Parser(text);
  parser.skipWhitespace();
  const value = parser.parseValue(0);
  parser.skipWhitespace();
  if (parser.index !== text.length) {
    throw new PythonJsonSyntaxError(`Extra data: char ${parser.index}`);
  }
  return {value, sawDuplicateKey: parser.sawDuplicateKey};
}

/**
 * `json.JSONDecoder().raw_decode` for a document that starts with `"`: decodes
 * the leading string literal and returns where it ends.
 */
/**
 * A leading JSON string literal, decoded, and the index just past its closing
 * quote.
 */
export interface DecodedStringPrefix {
  value: string;
  end: number;
}

export function pythonJsonRawDecodeString(text: string): DecodedStringPrefix {
  if (!text.startsWith('"')) {
    throw new PythonJsonSyntaxError('Expecting value: char 0');
  }
  const parser = new Parser(text);
  const value = parser.parseString();
  return {value, end: parser.index};
}

function escapeString(text: string): string {
  let out = '"';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const char = text.charAt(index);
    if (char === '"') {
      out += String.raw`\"`;
    } else if (char === '\\') {
      out += String.raw`\\`;
    } else if (char === '\n') {
      out += String.raw`\n`;
    } else if (char === '\r') {
      out += String.raw`\r`;
    } else if (char === '\t') {
      out += String.raw`\t`;
    } else if (char === '\b') {
      out += String.raw`\b`;
    } else if (char === '\f') {
      out += String.raw`\f`;
    } else if (code < 0x20 || code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

/**
 * Python `repr(float)`: shortest round-trip digits, exponent form below 1e-4 or
 * from 1e16.
 */
function formatNumber(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return 'Infinity';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '-Infinity';
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e16) {
    return String(value);
  }
  const [mantissa = '', exponentText = '0'] = value.toExponential().split('e');
  const exponent = Number(exponentText);
  if (exponent >= -4 && exponent < 16) {
    const fixed = String(value);
    return fixed.includes('.') || fixed.includes('e') ? fixed : `${fixed}.0`;
  }
  const sign = exponent < 0 ? '-' : '+';
  return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

/**
 * `json.dumps(value)` with Python's defaults: `ensure_ascii=True`, `", "` and
 * `": "` separators.
 */
export function pythonJsonDumps(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return formatNumber(value);
  }
  if (typeof value === 'string') {
    return escapeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJsonDumps(item)).join(', ')}]`;
  }
  const members = Object.keys(value).map((key) => {
    const member = value[key];
    return `${escapeString(key)}: ${pythonJsonDumps(member === undefined ? null : member)}`;
  });
  return `{${members.join(', ')}}`;
}
