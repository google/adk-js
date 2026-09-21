/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recursively converts snake_case keys of an object to camelCase.
 *
 * @param val The value to convert.
 * @returns The converted value.
 */
export function camelCaseKeys(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(camelCaseKeys);
  }
  if (val !== null && typeof val === 'object' && val.constructor === Object) {
    const obj = val as Record<string, unknown>;
    const newObj: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
      newObj[camelKey] = camelCaseKeys(obj[key]);
    }
    return newObj;
  }
  return val;
}

/**
 * Python's reserved words, as `keyword.kwlist` lists them.
 *
 * Python's, not TypeScript's, and that is the whole point. This rename exists
 * only to reproduce what adk-python does to a parameter name -- a JSON schema
 * property may be any string, so nothing in TypeScript needs it. Carrying the
 * ECMAScript list instead made the two disagree in both directions: `from`,
 * `import`, `not`, `is`, `def`, `pass`, `lambda` and `None` are renamed by the
 * reference and were not renamed here, while `function`, `var`, `let`,
 * `typeof` and `new` were renamed here and are not by the reference. `from` is
 * common in real specifications.
 *
 * The name the model finally sees comes out of this set, so a disagreement is
 * a behavioural difference, not a cosmetic one.
 */
const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

const DEFAULT_RESERVED_WORD_PREFIX = 'param_';

/**
 * Converts one string into snake_case.
 *
 * Handles lowerCamelCase, UpperCamelCase and space-separated text, as well as
 * acronyms such as `REST API` and runs of consecutive uppercase letters.
 *
 * The `Name` suffix separates this from `toSnakeCase` in
 * `object_notation_utils.ts`, which converts the keys of an object and takes a
 * different argument.
 *
 * @example
 * ```ts
 * toSnakeCaseName('camelCase'); // 'camel_case'
 * toSnakeCaseName('UpperCamelCase'); // 'upper_camel_case'
 * toSnakeCaseName('REST API'); // 'rest_api'
 * ```
 *
 * @param text The input string.
 * @returns The snake_case form of `text`.
 */
export function toSnakeCaseName(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Prefixes a Python keyword, the way adk-python's `rename_python_keywords`
 * does. Mirrors the reference exactly: the set is Python's, not TypeScript's.
 *
 * @example
 * ```ts
 * renameReservedKeywords('in'); // 'param_in'
 * renameReservedKeywords('total'); // 'total'
 * ```
 *
 * @param s The candidate identifier.
 * @param prefix The prefix to add when `s` is reserved.
 * @returns `prefix + s` when `s` is reserved, otherwise `s` unchanged.
 */
export function renameReservedKeywords(
  s: string,
  prefix: string = DEFAULT_RESERVED_WORD_PREFIX,
): string {
  return PYTHON_KEYWORDS.has(s) ? prefix + s : s;
}
