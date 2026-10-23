/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PythonJsonDepthError,
  pythonJsonDumps,
  pythonJsonLoads,
  PythonJsonNumber,
  pythonJsonRawDecodeString,
  PythonJsonSyntaxError,
  type DecodedStringPrefix,
  type PythonJsonValue,
} from './python_json.js';
import {exceedsCodePoints, sliceCodePoints} from './python_strings.js';
import {type JsonValue} from './types.js';

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'client_secret',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'password',
  'private_key',
  'proxy_authorization',
  'google_access_id',
  'sig',
  'signature',
  'token',
  'secret',
  'authorization',
  'x_api_key',
  'x_amz_credential',
  'x_amz_signature',
  'x_goog_credential',
  'x_goog_security_token',
  'x_goog_signature',
]);

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const SENSITIVE_TEXT_KEY_ALTERNATION = [...SENSITIVE_KEYS]
  .map((key) => escapeRegExp(key).replaceAll('_', '[-_]'))
  .sort((a, b) => b.length - a.length)
  .join('|');

// Python's `\s` on `str`, which also matches U+001C–U+001F and U+0085.
const PY_SPACE_CHARS = String.raw`\s\x1c-\x1f\x85`;
const PY_SPACE = `[${PY_SPACE_CHARS}]`;

// Unlike adk-python's pattern: a quote may open the key right after a word
// character (`-H'x-api-key: v'`, `b'api_key=v'`); a separator directly followed
// by a closing quote is a JSON label (`"Token: ", ...`), not a key; a quoted
// value missing its closing quote runs to the end of the line; and an unquoted
// value stops at quotes, so it never eats a JSON string's closing quote.
const SENSITIVE_TEXT_KEY_SOURCE =
  `(?<prefix>(?:(?<![A-Za-z0-9_-])["']?|(?<=[A-Za-z0-9_-])["'])(?:temp:[A-Za-z0-9_.-]+|${SENSITIVE_TEXT_KEY_ALTERNATION})["']?${PY_SPACE}*[:=](?!${PY_SPACE}*["']${PY_SPACE}*[,}\\]])${PY_SPACE}*)` +
  `(?<value>"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\\\r\\n])*|'(?:\\\\.|[^'\\\\\\r\\n])*|[^${PY_SPACE_CHARS},;&}"']+)`;

const AUTH_HEADER_SOURCE = String.raw`(?<prefix>\b(?:authorization|proxy-authorization|x-api-key|api-key)[ \t]*:[ \t]*)[^\r\n]*`;
const BEARER_TOKEN_SOURCE = String.raw`(?<prefix>\bbearer${PY_SPACE}+)(?!of(?:${PY_SPACE}|$))[^${PY_SPACE_CHARS},;"'}]+`;
const BASIC_TOKEN_SOURCE = String.raw`(?<prefix>\bbasic${PY_SPACE}+)(?<value>[A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])`;

const MAX_BASIC_AUTH_TOKEN_CHARS = 16 * 1024;
const ASCII_HEX = /^[0-9a-fA-F]+$/;

// Bounds that keep one sanitizer call from pinning the event loop or recursing
// without end; see the adk-python constants of the same names.
export const MAX_SANITIZE_DEPTH = 50;
export const MAX_SANITIZE_NODES = 100_000;
export const MAX_JSON_INSPECT_CHARS = 4_000_000;
const MAX_JSON_NESTING_DEPTH = 1000;

const REDACTED = '[REDACTED]';
const TRUNCATED_SUFFIX = '...[TRUNCATED]';
const UNPARSEABLE = '[UNPARSEABLE_JSON_BLOB]';
const UNSUPPORTED_OBJECT = '[UNSUPPORTED_OBJECT]';
const BUDGET_EXCEEDED = '[SANITIZE_BUDGET_EXCEEDED]';
export const MAX_DEPTH_EXCEEDED = '[MAX_DEPTH_EXCEEDED]';
export const CIRCULAR_REFERENCE = '[CIRCULAR_REFERENCE]';
const REDACTED_SENSITIVE_TEXT = '[REDACTED_SENSITIVE_TEXT]';

interface Budget {
  remaining: number;
}

type Sanitized = [value: PythonJsonValue, isTruncated: boolean];
type Normalized = [value: JsonValue, isTruncated: boolean];

/**
 * A JSON-native value, and whether anything was redacted, replaced or cut on
 * the way.
 */
export interface SanitizedValue {
  value: JsonValue;
  isTruncated: boolean;
}

// Length bounds count code points, like Python's `len`.
function truncateText(text: string, maxLen: number): string {
  return sliceCodePoints(text, maxLen) + TRUNCATED_SUFFIX;
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '_');
  return SENSITIVE_KEYS.has(normalized) || normalized.startsWith('temp:');
}

function defineKey<T extends PythonJsonValue>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Reads a property without invoking getters or Proxy-free accessor code: own
 * and inherited data properties only. Returns undefined on any failure (port of
 * `_safe_getattr`).
 */
export function safeGet(obj: unknown, name: string): unknown {
  try {
    let current: unknown = obj;
    while (
      current !== null &&
      (typeof current === 'object' || typeof current === 'function')
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        return 'value' in descriptor ? descriptor.value : undefined;
      }
      current = Object.getPrototypeOf(current);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns an enum-like value's label, else `unknown` (port of `_enum_label`).
 */
export function enumLabel(value: unknown): string {
  if (value === null || value === undefined) {
    return 'unknown';
  }
  if (typeof value === 'string') {
    return value === '' ? 'unknown' : value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return 'unknown';
}

/**
 * Python `str.isspace()`, which adds U+001C–U+001F and U+0085 to `\s`, or the
 * BOM.
 */
function isPythonSpaceOrBom(char: string): boolean {
  const code = char.charCodeAt(0);
  return /\s/.test(char) || (code >= 0x1c && code <= 0x1f) || code === 0x85;
}

/**
 * Strips BOMs and all Unicode whitespace from the start of a string in one
 * linear scan.
 */
export function stripBomWs(value: string): string {
  let index = 0;
  while (index < value.length && isPythonSpaceOrBom(value.charAt(index))) {
    index += 1;
  }
  return index === 0 ? value : value.slice(index);
}

function jsonNestingExceedsLimit(value: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      depth += 1;
      if (depth > MAX_JSON_NESTING_DEPTH) {
        return true;
      }
    } else if (char === ']' || char === '}') {
      depth -= 1;
    }
  }
  return false;
}

function isHexDigits(chars: ReadonlyArray<string>): boolean {
  return ASCII_HEX.test(chars.join(''));
}

/**
 * Decodes nested ASCII (and Unicode whitespace) `\u`, `\x` and percent escapes
 * in O(n), for credential detection only.
 */
export function canonicalizeCommonAsciiEscapes(text: string): string {
  const output: Array<string> = [];
  for (const char of text) {
    output.push(char);
    for (;;) {
      const length = output.length;
      let escapeStart = -1;
      let digits: ReadonlyArray<string> = [];
      let percent = false;
      if (
        length >= 6 &&
        output[length - 6] === '\\' &&
        (output[length - 5] === 'u' || output[length - 5] === 'U') &&
        isHexDigits(output.slice(-4))
      ) {
        escapeStart = length - 6;
        digits = output.slice(-4);
      } else if (
        length >= 4 &&
        output[length - 4] === '\\' &&
        (output[length - 3] === 'x' || output[length - 3] === 'X') &&
        isHexDigits(output.slice(-2))
      ) {
        escapeStart = length - 4;
        digits = output.slice(-2);
      } else if (
        length >= 3 &&
        output[length - 3] === '%' &&
        isHexDigits(output.slice(-2))
      ) {
        escapeStart = length - 3;
        digits = output.slice(-2);
        percent = true;
      }
      if (escapeStart < 0) {
        break;
      }
      const decoded = Number.parseInt(digits.join(''), 16);
      // Unicode whitespace such as U+00A0 can stand in for the spaces around a
      // key's `:` or `=`; a percent escape above 0x7f is a UTF-8 byte instead.
      if (
        decoded > 0x7f &&
        (percent || !isPythonSpaceOrBom(String.fromCharCode(decoded)))
      ) {
        break;
      }
      output.length = escapeStart;
      output.push(String.fromCharCode(decoded));
    }
  }
  return output.join('');
}

interface RedactionGroups {
  prefix: string;
  value: string;
}

/**
 * The `prefix` and `value` named groups from a `String#replaceAll` callback's
 * trailing groups argument.
 */
function groupsOf(args: ReadonlyArray<unknown>): RedactionGroups {
  const last = args.at(-1);
  if (typeof last !== 'object' || last === null) {
    return {prefix: '', value: ''};
  }
  const prefix = safeGet(last, 'prefix');
  const value = safeGet(last, 'value');
  return {
    prefix: typeof prefix === 'string' ? prefix : '',
    value: typeof value === 'string' ? value : '',
  };
}

/**
 * Python `base64.b64decode(encoded, validate=True)`: throws on bad alphabet or
 * padding.
 */
function strictBase64Decode(encoded: string): Buffer {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new RangeError('Incorrect padding');
  }
  return Buffer.from(encoded, 'base64');
}

interface PatternRedaction {
  text: string;
  changed: boolean;
}

function redactSensitivePatterns(text: string): PatternRedaction {
  const sanitized = text
    .replaceAll(
      new RegExp(AUTH_HEADER_SOURCE, 'gim'),
      (...args: Array<unknown>) => `${groupsOf(args).prefix}${REDACTED}`,
    )
    .replaceAll(
      new RegExp(BEARER_TOKEN_SOURCE, 'gi'),
      (...args: Array<unknown>) => `${groupsOf(args).prefix}${REDACTED}`,
    )
    .replaceAll(
      new RegExp(BASIC_TOKEN_SOURCE, 'gi'),
      (match: string, ...args: Array<unknown>) => {
        const {prefix, value: encoded} = groupsOf(args);
        if (encoded.length > MAX_BASIC_AUTH_TOKEN_CHARS) {
          return `${prefix}${REDACTED}`;
        }
        let decoded: Buffer;
        try {
          decoded = strictBase64Decode(encoded);
        } catch {
          return match;
        }
        if (!encoded.includes('=') && !decoded.includes(0x3a)) {
          return match;
        }
        return `${prefix}${REDACTED}`;
      },
    )
    .replaceAll(
      new RegExp(SENSITIVE_TEXT_KEY_SOURCE, 'gi'),
      (match: string, ...args: Array<unknown>) => {
        const {prefix, value} = groupsOf(args);
        if (value === REDACTED) {
          return match;
        }
        const quote =
          value.startsWith('"') || value.startsWith("'") ? value.charAt(0) : '';
        return `${prefix}${quote}${REDACTED}${quote}`;
      },
    );
  return {text: sanitized, changed: sanitized !== text};
}

export function containsSensitiveTextMarker(text: string): boolean {
  if (redactSensitivePatterns(text).changed) {
    return true;
  }
  const canonical = canonicalizeCommonAsciiEscapes(text);
  return canonical !== text && redactSensitivePatterns(canonical).changed;
}

function parsesAsJson(text: string): boolean {
  try {
    pythonJsonLoads(text);
    return true;
  } catch {
    return false;
  }
}

/** Sanitized text, and whether anything was redacted, replaced or cut. */
export interface SanitizedText {
  text: string;
  isTruncated: boolean;
}

/**
 * Redacts bounded credential material embedded in diagnostic text, preserving
 * ordinary prose byte-for-byte (port of `_sanitize_sensitive_text`).
 */
export function sanitizeSensitiveText({
  text,
  maxLen,
}: {
  text: string;
  maxLen: number;
}): SanitizedText {
  let source = text;
  let lengthTruncated = false;
  if (exceedsCodePoints(source, MAX_JSON_INSPECT_CHARS)) {
    if (maxLen === -1 || maxLen > MAX_JSON_INSPECT_CHARS) {
      return {text: REDACTED_SENSITIVE_TEXT, isTruncated: true};
    }
    source = sliceCodePoints(source, maxLen);
    lengthTruncated = true;
  }

  let sanitized = source;
  const stripped = stripBomWs(source);
  if (
    (stripped.startsWith('{') ||
      stripped.startsWith('[') ||
      stripped.startsWith('"')) &&
    parsesAsJson(stripped)
  ) {
    const [structured] = truncateNode(source, -1, new Set(), 0, {
      remaining: MAX_SANITIZE_NODES,
    });
    sanitized =
      typeof structured === 'string' ? structured : pythonJsonDumps(structured);
  }

  let changed = sanitized !== source;
  const patterns = redactSensitivePatterns(sanitized);
  sanitized = patterns.text;
  changed ||= patterns.changed;

  const canonical = canonicalizeCommonAsciiEscapes(sanitized);
  if (canonical !== sanitized && containsSensitiveTextMarker(canonical)) {
    return {text: REDACTED_SENSITIVE_TEXT, isTruncated: true};
  }

  if (exceedsCodePoints(sanitized, maxLen)) {
    sanitized = truncateText(sanitized, maxLen);
    lengthTruncated = true;
  }
  return {text: sanitized, isTruncated: changed || lengthTruncated};
}

type BlobResult = [text: string, changed: boolean, truncated: boolean];

const UNPARSEABLE_RESULT: BlobResult = [UNPARSEABLE, true, true];

/**
 * Whether an unterminated string literal could still encode a container or a
 * nested layer anywhere after its opening quote, so it fails closed.
 */
function mayHideContainer(fromQuote: string): boolean {
  const rest = fromQuote.slice(1);
  return (
    rest.includes('{') ||
    rest.includes('[') ||
    rest.includes('\\') ||
    stripBomWs(rest).startsWith('"')
  );
}

/**
 * Sanitizes a decoded string layer; null means the whole value fails closed.
 */
function sanitizeDecodedLayer(
  decoded: string,
  seen: Set<unknown>,
  depth: number,
  maxLen: number,
  budget: Budget,
): BlobResult | null {
  const inner = stripBomWs(decoded);
  if (inner.startsWith('{') || inner.startsWith('[') || inner.startsWith('"')) {
    return sanitizeJsonBlob(decoded, seen, depth, maxLen, budget);
  }
  const result = sanitizeFreeText(decoded, seen, depth, maxLen, budget);
  return result[1] && result[0] === UNPARSEABLE ? null : result;
}

/**
 * Port of `_sanitize_free_text`: walks every quoted fragment in prose through
 * the blob sanitizer. Sibling fragments share one depth; only a decoded layer
 * goes one level deeper.
 */
function sanitizeFreeText(
  text: string,
  seen: Set<unknown>,
  depth: number,
  maxLen: number,
  budget: Budget,
): BlobResult {
  if (text.includes('{') || text.includes('[')) {
    return UNPARSEABLE_RESULT;
  }
  let out = '';
  let rest = text;
  let changed = false;
  let truncated = false;
  for (;;) {
    const quoteIndex = rest.indexOf('"');
    if (quoteIndex === -1) {
      out += rest;
      break;
    }
    const gap = rest.slice(0, quoteIndex);
    if (gap.includes('\\')) {
      return UNPARSEABLE_RESULT;
    }
    budget.remaining -= 1;
    if (budget.remaining < 0 || depth + 1 >= MAX_SANITIZE_DEPTH) {
      return UNPARSEABLE_RESULT;
    }
    const fromQuote = rest.slice(quoteIndex);
    let literal: DecodedStringPrefix;
    try {
      literal = pythonJsonRawDecodeString(fromQuote);
    } catch {
      if (mayHideContainer(fromQuote)) {
        return UNPARSEABLE_RESULT;
      }
      out += rest;
      break;
    }
    const layer = sanitizeDecodedLayer(
      literal.value,
      seen,
      depth + 1,
      maxLen,
      budget,
    );
    if (layer === null) {
      return UNPARSEABLE_RESULT;
    }
    const [sanitized, layerChanged, layerTruncated] = layer;
    out +=
      gap +
      (layerChanged
        ? pythonJsonDumps(sanitized)
        : fromQuote.slice(0, literal.end));
    changed ||= layerChanged;
    truncated ||= layerTruncated;
    rest = fromQuote.slice(literal.end);
  }
  return changed ? [out, true, truncated] : [text, false, false];
}

/**
 * Redacts sensitive keys inside a JSON-encoded string blob, decoding first so
 * escaped keys and nested string layers cannot hide credentials (port of
 * `_sanitize_json_blob`).
 */
function sanitizeJsonBlob(
  value: string,
  seen: Set<unknown>,
  depth: number,
  maxLen: number,
  budget: Budget,
): BlobResult {
  const stripped = stripBomWs(value);
  const inspectLimit =
    maxLen === -1
      ? MAX_JSON_INSPECT_CHARS
      : Math.min(maxLen, MAX_JSON_INSPECT_CHARS);

  if (stripped.startsWith('"')) {
    if (depth >= MAX_SANITIZE_DEPTH) {
      return UNPARSEABLE_RESULT;
    }
    if (exceedsCodePoints(stripped, inspectLimit)) {
      const emitted =
        maxLen === -1 ? stripped : sliceCodePoints(stripped, maxLen);
      if (
        emitted.includes('{') ||
        emitted.includes('[') ||
        emitted.includes('\\')
      ) {
        return UNPARSEABLE_RESULT;
      }
      return [value, false, false];
    }
    let decoded: PythonJsonValue;
    let end = stripped.length;
    let suffix = '';
    try {
      decoded = pythonJsonLoads(stripped).value;
    } catch (error) {
      if (!(error instanceof PythonJsonSyntaxError)) {
        return UNPARSEABLE_RESULT;
      }
      try {
        const leading = pythonJsonRawDecodeString(stripped);
        decoded = leading.value;
        end = leading.end;
      } catch {
        return mayHideContainer(stripped)
          ? UNPARSEABLE_RESULT
          : [value, false, false];
      }
      suffix = stripped.slice(end);
    }
    if (typeof decoded !== 'string') {
      return [value, false, false];
    }
    if (
      suffix.includes('{') ||
      suffix.includes('[') ||
      stripBomWs(suffix).startsWith('\\')
    ) {
      return UNPARSEABLE_RESULT;
    }
    const [suffixSanitized, suffixChanged, suffixTruncated] = sanitizeFreeText(
      suffix,
      seen,
      depth,
      maxLen,
      budget,
    );
    if (suffixChanged && suffixSanitized === UNPARSEABLE) {
      return UNPARSEABLE_RESULT;
    }
    const layer = sanitizeDecodedLayer(
      decoded,
      seen,
      depth + 1,
      maxLen,
      budget,
    );
    if (layer === null) {
      return UNPARSEABLE_RESULT;
    }
    const [prefixSanitized, prefixChanged, prefixTruncated] = layer;
    if (!prefixChanged && !suffixChanged) {
      return [value, false, false];
    }
    const prefixText = prefixChanged
      ? pythonJsonDumps(prefixSanitized)
      : stripped.slice(0, end);
    const suffixText = suffixChanged ? suffixSanitized : suffix;
    return [prefixText + suffixText, true, prefixTruncated || suffixTruncated];
  }

  if (!stripped.startsWith('{') && !stripped.startsWith('[')) {
    return [value, false, false];
  }
  if (
    exceedsCodePoints(stripped, inspectLimit) ||
    jsonNestingExceedsLimit(stripped)
  ) {
    return UNPARSEABLE_RESULT;
  }
  try {
    const {value: parsed, sawDuplicateKey} = pythonJsonLoads(stripped);
    if (typeof parsed !== 'object' || parsed === null) {
      return [value, false, false];
    }
    const [sanitized, nestedTruncated] = truncateNode(
      parsed,
      -1,
      seen,
      depth + 1,
      budget,
    );
    if (!sawDuplicateKey && !nestedTruncated && jsonEqual(sanitized, parsed)) {
      return [value, false, false];
    }
    return [pythonJsonDumps(sanitized), true, nestedTruncated];
  } catch (error) {
    if (
      error instanceof PythonJsonSyntaxError ||
      error instanceof PythonJsonDepthError ||
      error instanceof RangeError
    ) {
      return UNPARSEABLE_RESULT;
    }
    throw error;
  }
}

function jsonEqual(a: PythonJsonValue, b: PythonJsonValue): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a instanceof PythonJsonNumber || b instanceof PythonJsonNumber) {
    return (
      a instanceof PythonJsonNumber &&
      b instanceof PythonJsonNumber &&
      a.text === b.text
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index] ?? null))
    );
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every(
      (key) =>
        Object.hasOwn(b, key) && jsonEqual(a[key] ?? null, b[key] ?? null),
    )
  );
}

export function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function objectTag(value: object): string {
  return Object.prototype.toString.call(value);
}

export function isBytes(value: object): value is Uint8Array | ArrayBuffer {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    objectTag(value) === '[object ArrayBuffer]'
  );
}

function bigintToJson(value: bigint): JsonValue {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
}

interface OwnEntry {
  key: string;
  value: unknown;
  accessor: boolean;
}

function* iterateOwnEntries(obj: object): Generator<OwnEntry> {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (descriptor?.enumerable !== true) {
      continue;
    }
    yield 'value' in descriptor
      ? {key, value: descriptor.value, accessor: false}
      : {key, value: undefined, accessor: true};
  }
}

/**
 * Own enumerable string-keyed properties, read through descriptors so no getter
 * runs. Stops after `maxEntries`, so a huge object costs no more than the
 * caller's budget.
 */
export function ownEntries(
  obj: object,
  maxEntries = Number.POSITIVE_INFINITY,
): Array<OwnEntry> {
  const entries: Array<OwnEntry> = [];
  if (maxEntries <= 0) {
    return entries;
  }
  for (const entry of iterateOwnEntries(obj)) {
    entries.push(entry);
    if (entries.length >= maxEntries) {
      break;
    }
  }
  return entries;
}

function mapKeyToJson(key: unknown): string | null {
  if (typeof key === 'string') {
    return key;
  }
  if (key === true) {
    return 'true';
  }
  if (key === false) {
    return 'false';
  }
  if (key === null || key === undefined) {
    return 'null';
  }
  if (typeof key === 'number') {
    return pythonJsonDumps(key);
  }
  if (typeof key === 'bigint') {
    return key.toString();
  }
  return null;
}

function allocateCollisionKey(
  target: Record<string, PythonJsonValue>,
  key: string,
  counter: {value: number},
): string {
  counter.value += 1;
  let candidate = `[KEY_COLLISION_${counter.value}]${key}`;
  while (Object.hasOwn(target, candidate)) {
    counter.value += 1;
    candidate = `[KEY_COLLISION_${counter.value}]${key}`;
  }
  return candidate;
}

function truncateMapping(
  entries: Iterable<readonly [unknown, unknown]>,
  maxLen: number,
  seen: Set<unknown>,
  depth: number,
  budget: Budget,
): Sanitized {
  let truncatedAny = false;
  const out: Record<string, PythonJsonValue> = {};
  const counter = {value: 0};
  for (const [rawKey, value] of entries) {
    if (budget.remaining <= 0) {
      defineKey(out, BUDGET_EXCEEDED, BUDGET_EXCEEDED);
      truncatedAny = true;
      break;
    }
    const jsonKey = mapKeyToJson(rawKey);
    const redactValue = typeof rawKey === 'string' && isSensitiveKey(rawKey);
    let key: string;
    if (jsonKey === null) {
      counter.value += 1;
      budget.remaining -= 1;
      key =
        counter.value === 1
          ? '[UNSUPPORTED_KEY]'
          : `[UNSUPPORTED_KEY_${counter.value}]`;
      truncatedAny = true;
    } else {
      key = jsonKey;
    }
    if (Object.hasOwn(out, key)) {
      key = allocateCollisionKey(out, key, counter);
      truncatedAny = true;
    }
    if (redactValue) {
      budget.remaining -= 1;
      defineKey(out, key, REDACTED);
      continue;
    }
    const [sanitized, truncated] = truncateNode(
      value === undefined ? null : value,
      maxLen,
      seen,
      depth + 1,
      budget,
    );
    truncatedAny ||= truncated;
    defineKey(out, key, sanitized);
  }
  return [out, truncatedAny];
}

// An enumerable getter on a plain object is never invoked; it fails closed like
// an unsupported value.
const ACCESSOR_PLACEHOLDER = Symbol('accessor');

/**
 * A plain object's entries, skipping `undefined` values like `JSON.stringify`.
 * Stops after `maxEntries` kept entries.
 */
function plainObjectEntries(
  obj: object,
  maxEntries: number,
): Array<readonly [string, unknown]> {
  const entries: Array<readonly [string, unknown]> = [];
  if (maxEntries <= 0) {
    return entries;
  }
  for (const {key, value, accessor} of iterateOwnEntries(obj)) {
    if (accessor) {
      entries.push([key, ACCESSOR_PLACEHOLDER]);
    } else if (value !== undefined) {
      entries.push([key, value]);
    }
    if (entries.length >= maxEntries) {
      break;
    }
  }
  return entries;
}

function isConversionProgress(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    Array.isArray(value) ||
    (typeof value === 'object' &&
      value !== null &&
      (value instanceof Map || isBytes(value) || isPlainObject(value)))
  );
}

/**
 * Port of `_recursive_smart_truncate` over JavaScript values; see {@link
 * recursiveSmartTruncate}.
 */
function truncateNode(
  obj: unknown,
  maxLen: number,
  seen: Set<unknown>,
  depth: number,
  budget: Budget,
): Sanitized {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    return [BUDGET_EXCEEDED, true];
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return [MAX_DEPTH_EXCEEDED, true];
  }
  if (seen.has(obj)) {
    return [CIRCULAR_REFERENCE, false];
  }
  if (typeof obj === 'string') {
    const [text, blobReplaced, blobTruncated] = sanitizeJsonBlob(
      obj,
      seen,
      depth,
      maxLen,
      budget,
    );
    if (blobReplaced && text === UNPARSEABLE) {
      return [text, true];
    }
    if (exceedsCodePoints(text, maxLen)) {
      return [truncateText(text, maxLen), true];
    }
    return [text, blobTruncated];
  }
  if (obj === null || obj === undefined) {
    return [null, false];
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return [obj, false];
  }
  if (typeof obj === 'bigint') {
    return [bigintToJson(obj), false];
  }
  if (typeof obj !== 'object') {
    return [UNSUPPORTED_OBJECT, true];
  }
  if (obj instanceof PythonJsonNumber) {
    return [obj, false];
  }

  seen.add(obj);
  try {
    if (isBytes(obj)) {
      const bytes = obj instanceof Uint8Array ? obj : new Uint8Array(obj);
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        return ['[BINARY_DATA]', true];
      }
      return truncateNode(decoded, maxLen, seen, depth + 1, budget);
    }
    if (obj instanceof Map) {
      const entries: Array<readonly [unknown, unknown]> = [];
      const iterator = Map.prototype.entries.call(obj) as Iterator<
        [unknown, unknown]
      >;
      while (entries.length <= budget.remaining) {
        const next = iterator.next();
        if (next.done === true) {
          break;
        }
        entries.push(next.value);
      }
      return truncateMapping(entries, maxLen, seen, depth, budget);
    }
    if (Array.isArray(obj)) {
      let truncatedAny = false;
      const out: Array<PythonJsonValue> = [];
      const lengthDescriptor = Object.getOwnPropertyDescriptor(obj, 'length');
      const length =
        lengthDescriptor !== undefined && 'value' in lengthDescriptor
          ? Number(lengthDescriptor.value)
          : 0;
      for (let index = 0; index < length; index += 1) {
        if (budget.remaining <= 0) {
          out.push(BUDGET_EXCEEDED);
          truncatedAny = true;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(obj, index);
        const item: unknown =
          descriptor !== undefined && 'value' in descriptor
            ? descriptor.value
            : null;
        const [sanitized, truncated] = truncateNode(
          item,
          maxLen,
          seen,
          depth + 1,
          budget,
        );
        truncatedAny ||= truncated;
        out.push(sanitized);
      }
      return [out, truncatedAny];
    }
    if (isPlainObject(obj)) {
      return truncateMapping(
        plainObjectEntries(obj, budget.remaining + 1),
        maxLen,
        seen,
        depth,
        budget,
      );
    }
    if (ArrayBuffer.isView(obj)) {
      return [UNSUPPORTED_OBJECT, true];
    }
    if (obj instanceof Date) {
      return truncateNode(
        Date.prototype.toISOString.call(obj),
        maxLen,
        seen,
        depth + 1,
        budget,
      );
    }
    // The JavaScript counterpart of Python's model_dump() converter: a
    // converter that throws or makes no progress fails closed rather than
    // exposing the fields it was written to replace.
    const toJson = safeGet(obj, 'toJSON');
    if (typeof toJson === 'function') {
      try {
        const dumped: unknown = Reflect.apply(toJson, obj, []);
        if (isConversionProgress(dumped)) {
          return truncateNode(dumped, maxLen, seen, depth + 1, budget);
        }
        if (
          dumped === null ||
          typeof dumped === 'number' ||
          typeof dumped === 'boolean'
        ) {
          return [dumped, false];
        }
      } catch {
        // Falls through to the sentinel below.
      }
      return [UNSUPPORTED_OBJECT, true];
    }
    const publicAttrs: Array<readonly [string, unknown]> = [];
    let overflow = false;
    for (const {key, value, accessor} of ownEntries(
      obj,
      budget.remaining + 1,
    )) {
      if (budget.remaining <= 0) {
        overflow = true;
        break;
      }
      budget.remaining -= 1;
      if (!key.startsWith('_') && !accessor) {
        publicAttrs.push([key, value]);
      }
    }
    if (publicAttrs.length > 0 || overflow) {
      // Every visited attribute paid for the scan; the kept ones are refunded
      // so that sanitizing their values is not charged twice.
      budget.remaining += publicAttrs.length;
      const [sanitized, truncated] = truncateMapping(
        publicAttrs,
        maxLen,
        seen,
        depth + 1,
        budget,
      );
      if (
        overflow &&
        typeof sanitized === 'object' &&
        sanitized !== null &&
        !Array.isArray(sanitized) &&
        !(sanitized instanceof PythonJsonNumber)
      ) {
        defineKey(sanitized, BUDGET_EXCEEDED, BUDGET_EXCEEDED);
        return [sanitized, true];
      }
      return [sanitized, truncated];
    }
    return [UNSUPPORTED_OBJECT, true];
  } catch {
    return [UNSUPPORTED_OBJECT, true];
  } finally {
    seen.delete(obj);
  }
}

/**
 * Recursively bounds string lengths and redacts credential-bearing keys and
 * JSON blobs, failing closed to sentinels on anything it cannot verify (port of
 * `_recursive_smart_truncate`).
 *
 * Keys are kept verbatim. Plain objects and `Map`s are mappings; class
 * instances contribute their own enumerable, non-`_` data properties (or a
 * `toJSON()` result); getters never run.
 */
export function recursiveSmartTruncate({
  value,
  maxLen,
  budget = MAX_SANITIZE_NODES,
}: {
  value: unknown;
  maxLen: number;
  budget?: number;
}): SanitizedValue {
  const [sanitized, isTruncated] = truncateNode(value, maxLen, new Set(), 0, {
    remaining: budget,
  });
  // A PythonJsonNumber only comes from parsing a JSON blob, which is
  // re-serialized to a string before the walk returns.
  return {value: sanitized as JsonValue, isTruncated};
}

function normalizeNode(
  obj: unknown,
  maxLen: number,
  depth: number,
  budget: Budget,
): Normalized {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    return [BUDGET_EXCEEDED, true];
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return [MAX_DEPTH_EXCEEDED, true];
  }
  try {
    if (typeof obj === 'string') {
      return exceedsCodePoints(obj, maxLen)
        ? [truncateText(obj, maxLen), true]
        : [obj, false];
    }
    if (obj === null || obj === undefined) {
      return [null, false];
    }
    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return [obj, false];
    }
    if (typeof obj === 'bigint') {
      return [bigintToJson(obj), false];
    }
    if (Array.isArray(obj)) {
      let replaced = false;
      const out: Array<JsonValue> = [];
      for (const item of obj) {
        if (budget.remaining <= 0) {
          out.push(BUDGET_EXCEEDED);
          replaced = true;
          break;
        }
        const [normalized, itemReplaced] = normalizeNode(
          item,
          maxLen,
          depth + 1,
          budget,
        );
        replaced ||= itemReplaced;
        out.push(normalized);
      }
      return [out, replaced];
    }
    if (typeof obj === 'object' && isPlainObject(obj)) {
      let replaced = false;
      const out: Record<string, JsonValue> = {};
      const counter = {value: 0};
      for (const [rawKey, value] of plainObjectEntries(
        obj,
        budget.remaining + 1,
      )) {
        if (budget.remaining <= 0) {
          const budgetKey = Object.hasOwn(out, BUDGET_EXCEEDED)
            ? allocateCollisionKey(out, BUDGET_EXCEEDED, counter)
            : BUDGET_EXCEEDED;
          defineKey(out, budgetKey, BUDGET_EXCEEDED);
          replaced = true;
          break;
        }
        const key = Object.hasOwn(out, rawKey)
          ? allocateCollisionKey(out, rawKey, counter)
          : rawKey;
        if (isSensitiveKey(rawKey)) {
          budget.remaining -= 1;
          defineKey(out, key, REDACTED);
          continue;
        }
        if (value === ACCESSOR_PLACEHOLDER) {
          budget.remaining -= 1;
          defineKey(out, key, UNSUPPORTED_OBJECT);
          replaced = true;
          continue;
        }
        const [normalized, valueReplaced] = normalizeNode(
          value,
          maxLen,
          depth + 1,
          budget,
        );
        replaced ||= valueReplaced;
        defineKey(out, key, normalized);
      }
      return [out, replaced];
    }
    return [UNSUPPORTED_OBJECT, true];
  } catch {
    return [UNSUPPORTED_OBJECT, true];
  }
}

/**
 * Coerces already-sanitized parser output to strictly JSON-native values,
 * re-applying key redaction and the length bound but not JSON-blob inspection
 * (port of `_normalize_json_native`).
 */
export function normalizeJsonNative({
  value,
  maxLen,
  budget = MAX_SANITIZE_NODES,
}: {
  value: unknown;
  maxLen: number;
  budget?: number;
}): SanitizedValue {
  const [normalized, isTruncated] = normalizeNode(value, maxLen, 0, {
    remaining: budget,
  });
  return {value: normalized, isTruncated};
}
