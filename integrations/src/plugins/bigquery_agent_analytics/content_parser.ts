/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ContentPartRow} from './event_schema.js';

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

const SENSITIVE_KEY_PATTERN = Array.from(SENSITIVE_KEYS)
  .map((k) => k.replace(/_/g, '[-_]'))
  .sort((a, b) => b.length - a.length)
  .join('|');

const SENSITIVE_KEY_VALUE_RE = new RegExp(
  `(?<prefix>(?:^|[^A-Za-z0-9_-])(?:["'])?(?:temp:[A-Za-z0-9_.-]+|${SENSITIVE_KEY_PATTERN})(?:["'])?\\s*[:=]\\s*)(?<value>"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'|[^\\s,;&}]+)`,
  'gi',
);

const AUTH_HEADER_RE =
  /(?<prefix>\b(?:authorization|proxy-authorization|x-api-key|api-key)[ \t]*:[ \t]*)[^\r\n]*/gi;

const BEARER_TOKEN_RE = /(?<prefix>\bbearer\s+)(?!of(?:\s|$))[^\s,;]+/gi;

const BASIC_TOKEN_RE =
  /(?<prefix>\bbasic\s+)(?<value>[A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi;

const MAX_SANITIZE_DEPTH = 50;
const MAX_SANITIZE_NODES = 100000;
const MAX_BASIC_AUTH_TOKEN_CHARS = 16 * 1024;

/** Result of parsing an event content payload. */
export interface ParsedContentResult {
  readonly content: unknown;
  readonly contentParts: ContentPartRow[];
  readonly truncated: boolean;
}

/** Result of truncating a value. */
export interface TruncateResult<T = unknown> {
  readonly value: T;
  readonly truncated: boolean;
}

/**
 * Normalizes a key for sensitivity inspection.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, '_');
  return SENSITIVE_KEYS.has(normalized) || normalized.startsWith('temp:');
}

/**
 * Counts the number of Unicode code points in a string.
 */
export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * Truncates text by Unicode code points, never splitting a surrogate pair.
 */
export function truncateCodePoints(
  text: string,
  maxLen: number,
): TruncateResult<string> {
  if (maxLen === -1) {
    return {value: text, truncated: false};
  }
  const codePoints = Array.from(text);
  if (codePoints.length <= maxLen) {
    return {value: text, truncated: false};
  }
  return {
    value: codePoints.slice(0, maxLen).join('') + '...[TRUNCATED]',
    truncated: true,
  };
}

/**
 * Decodes basic authentication token and verifies whether it represents user:password.
 */
function isBasicCredential(encoded: string): boolean {
  if (encoded.length > MAX_BASIC_AUTH_TOKEN_CHARS) {
    return true;
  }
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return decoded.includes(':') || encoded.includes('=');
  } catch {
    return false;
  }
}

/**
 * Redacts credential patterns (authorization headers, bearer tokens, basic tokens, sensitive keys) from text.
 */
export function sanitizeText(
  text: string,
  maxLen: number = -1,
): TruncateResult<string> {
  let sanitized = text.replace(AUTH_HEADER_RE, '$1[REDACTED]');
  sanitized = sanitized.replace(BEARER_TOKEN_RE, '$1[REDACTED]');
  sanitized = sanitized.replace(
    BASIC_TOKEN_RE,
    (match: string, prefix: string, value: string) => {
      if (isBasicCredential(value)) {
        return `${prefix}[REDACTED]`;
      }
      return match;
    },
  );
  sanitized = sanitized.replace(
    SENSITIVE_KEY_VALUE_RE,
    (match: string, prefix: string, value: string) => {
      if (
        value === '[REDACTED]' ||
        value === '"[REDACTED]"' ||
        value === "'[REDACTED]'"
      ) {
        return match;
      }
      const quoteChar =
        value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      return `${prefix}${quoteChar}[REDACTED]${quoteChar}`;
    },
  );

  const changed = sanitized !== text;
  const truncated = truncateCodePoints(sanitized, maxLen);
  return {
    value: truncated.value,
    truncated: changed || truncated.truncated,
  };
}

/**
 * Sanitizes an external URI, redacting userinfo and sensitive query parameters.
 */
export function sanitizeExternalUri(
  rawUri: string | null | undefined,
  maxLen: number = -1,
): TruncateResult<string | null> {
  if (rawUri === null || rawUri === undefined) {
    return {value: null, truncated: false};
  }
  if (typeof rawUri !== 'string') {
    return {value: '[REDACTED_SENSITIVE_URI]', truncated: true};
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    // If not a valid standard URL, inspect via regex
    const sanitized = sanitizeText(rawUri, maxLen);
    return sanitized;
  }

  let changed = false;
  if (parsed.username || parsed.password) {
    return {value: '[REDACTED_SENSITIVE_URI]', truncated: true};
  }

  const searchParams = new URLSearchParams(parsed.search);
  for (const entry of Array.from(searchParams.entries())) {
    const key = entry[0];
    if (isSensitiveKey(key)) {
      searchParams.set(key, '[REDACTED]');
      changed = true;
    }
  }
  parsed.search = searchParams.toString();

  const finalUri = parsed.toString();
  const truncated = truncateCodePoints(finalUri, maxLen);
  return {
    value: truncated.value,
    truncated: changed || truncated.truncated,
  };
}

/**
 * Recursively truncates strings, redacting sensitive keys and enforcing depth/budget limits.
 */
export function smartTruncate(
  obj: unknown,
  maxLen: number,
  seen: Set<object> = new Set<object>(),
  depth: number = 0,
  budget: {count: number} = {count: MAX_SANITIZE_NODES},
): TruncateResult<unknown> {
  budget.count -= 1;
  if (budget.count < 0) {
    return {value: '[SANITIZE_BUDGET_EXCEEDED]', truncated: true};
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return {value: '[MAX_DEPTH_EXCEEDED]', truncated: true};
  }

  if (obj === null || obj === undefined) {
    return {value: obj, truncated: false};
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return {value: obj, truncated: false};
  }
  if (typeof obj === 'string') {
    return sanitizeText(obj, maxLen);
  }
  if (obj instanceof Date) {
    return {value: obj.toISOString(), truncated: false};
  }
  if (typeof obj !== 'object') {
    return {value: '[UNSUPPORTED_OBJECT]', truncated: true};
  }

  if (seen.has(obj)) {
    return {value: '[CIRCULAR_REFERENCE]', truncated: false};
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      let anyTruncated = false;
      const result: unknown[] = [];
      for (const item of obj) {
        if (budget.count <= 0) {
          result.push('[SANITIZE_BUDGET_EXCEEDED]');
          anyTruncated = true;
          break;
        }
        const itemResult = smartTruncate(item, maxLen, seen, depth + 1, budget);
        result.push(itemResult.value);
        if (itemResult.truncated) {
          anyTruncated = true;
        }
      }
      return {value: result, truncated: anyTruncated};
    }

    // Handle plain objects or class instances with properties
    const proto = Object.getPrototypeOf(obj);
    const isPlain = proto === null || proto === Object.prototype;
    const entries = Object.entries(obj);

    if (!isPlain && entries.length === 0) {
      return {value: '[UNSUPPORTED_OBJECT]', truncated: true};
    }

    let anyTruncated = false;
    const result: Record<string, unknown> = {};
    let collisionCount = 0;

    for (const entry of entries) {
      const key = entry[0];
      const value = entry[1];
      if (budget.count <= 0) {
        result['[SANITIZE_BUDGET_EXCEEDED]'] = '[SANITIZE_BUDGET_EXCEEDED]';
        anyTruncated = true;
        break;
      }

      let targetKey = key;
      if (Object.prototype.hasOwnProperty.call(result, targetKey)) {
        collisionCount += 1;
        targetKey = `[KEY_COLLISION_${collisionCount}]${key}`;
        anyTruncated = true;
      }

      if (isSensitiveKey(key)) {
        budget.count -= 1;
        result[targetKey] = '[REDACTED]';
        continue;
      }

      const valResult = smartTruncate(value, maxLen, seen, depth + 1, budget);
      result[targetKey] = valResult.value;
      if (valResult.truncated) {
        anyTruncated = true;
      }
    }

    return {value: result, truncated: anyTruncated};
  } finally {
    seen.delete(obj);
  }
}

/**
 * Converts camelCase keys of an object to snake_case.
 */
export function convertKeysToSnakeCase(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(convertKeysToSnakeCase);
  }
  const result: Record<string, unknown> = {};
  for (const entry of Object.entries(value as Record<string, unknown>)) {
    const k = entry[0];
    const v = entry[1];
    const snakeKey = k.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    result[snakeKey] = convertKeysToSnakeCase(v);
  }
  return result;
}

interface RawPartLike {
  readonly text?: string;
  readonly inlineData?: {readonly mimeType?: string; readonly data?: unknown};
  readonly fileData?: {readonly mimeType?: string; readonly fileUri?: string};
  readonly functionCall?: {readonly name?: string; readonly args?: unknown};
  readonly functionResponse?: {
    readonly name?: string;
    readonly response?: unknown;
  };
  readonly executableCode?: {
    readonly language?: string;
    readonly code?: string;
  };
  readonly codeExecutionResult?: {
    readonly outcome?: string;
    readonly output?: string;
  };
}

interface RawContentLike {
  readonly role?: string;
  readonly parts?: readonly RawPartLike[];
}

interface RawLlmRequestLike {
  readonly contents?: readonly RawContentLike[];
  readonly config?: {
    readonly systemInstruction?: string | RawContentLike;
  };
}

function parsePart(
  rawPart: RawPartLike,
  index: number,
  maxLen: number,
): {partRow: ContentPartRow; summary: string | null; truncated: boolean} {
  let isTruncated = false;

  if (rawPart.fileData) {
    const fileData = rawPart.fileData;
    const sanitizedUri = sanitizeExternalUri(fileData.fileUri, maxLen);
    return {
      partRow: {
        part_index: index,
        mime_type: fileData.mimeType ?? 'text/plain',
        uri: sanitizedUri.value,
        text: null,
        part_attributes: '{}',
        storage_mode: 'EXTERNAL_URI',
        object_ref: null,
      },
      summary: null,
      truncated: sanitizedUri.truncated,
    };
  }

  if (rawPart.inlineData) {
    const inlineData = rawPart.inlineData;
    return {
      partRow: {
        part_index: index,
        mime_type: inlineData.mimeType ?? 'application/octet-stream',
        uri: null,
        text: '[BINARY DATA]',
        part_attributes: '{}',
        storage_mode: 'INLINE',
        object_ref: null,
      },
      summary: null,
      truncated: false,
    };
  }

  if (rawPart.functionCall) {
    const name = rawPart.functionCall.name ?? 'unknown';
    const text = `Function: ${name}`;
    return {
      partRow: {
        part_index: index,
        mime_type: 'application/json',
        uri: null,
        text,
        part_attributes: JSON.stringify({function_name: name}),
        storage_mode: 'INLINE',
        object_ref: null,
      },
      summary: text,
      truncated: false,
    };
  }

  if (rawPart.functionResponse) {
    const fnResp = rawPart.functionResponse;
    const name = fnResp.name ?? 'unknown';
    const text = `Function response: ${name}`;
    const truncatedResponse = smartTruncate(fnResp.response, maxLen);
    return {
      partRow: {
        part_index: index,
        mime_type: 'application/json',
        uri: null,
        text,
        part_attributes: JSON.stringify({
          function_response: {name, response: truncatedResponse.value},
        }),
        storage_mode: 'INLINE',
        object_ref: null,
      },
      summary: text,
      truncated: truncatedResponse.truncated,
    };
  }

  if (rawPart.executableCode) {
    const exec = rawPart.executableCode;
    const language = exec.language ?? 'unknown';
    const code = exec.code ?? '';
    const truncatedCode = truncateCodePoints(code, maxLen);
    const summary = `Executable code (${language}): ${truncatedCode.value}`;
    return {
      partRow: {
        part_index: index,
        mime_type: 'text/plain',
        uri: null,
        text: truncatedCode.value,
        part_attributes: JSON.stringify({executable_code: exec}),
        storage_mode: 'INLINE',
        object_ref: null,
      },
      summary,
      truncated: truncatedCode.truncated,
    };
  }

  if (rawPart.codeExecutionResult) {
    const res = rawPart.codeExecutionResult;
    const outcome = res.outcome ?? 'unknown';
    const output = res.output ?? '';
    const truncatedOutput = truncateCodePoints(output, maxLen);
    const summary = `Code execution result (${outcome}): ${truncatedOutput.value}`;
    return {
      partRow: {
        part_index: index,
        mime_type: 'text/plain',
        uri: null,
        text: truncatedOutput.value,
        part_attributes: JSON.stringify({code_execution_result: res}),
        storage_mode: 'INLINE',
        object_ref: null,
      },
      summary,
      truncated: truncatedOutput.truncated,
    };
  }

  // Text part
  const rawText = rawPart.text ?? '';
  const sanitized = sanitizeText(rawText, maxLen);
  if (sanitized.truncated) {
    isTruncated = true;
  }
  return {
    partRow: {
      part_index: index,
      mime_type: 'text/plain',
      uri: null,
      text: sanitized.value,
      part_attributes: '{}',
      storage_mode: 'INLINE',
      object_ref: null,
    },
    summary: sanitized.value,
    truncated: isTruncated,
  };
}

function parseContentObject(
  contentObj: RawContentLike | RawPartLike,
  maxLen: number,
  startPartIndex: number = 0,
): {summary: string; parts: ContentPartRow[]; truncated: boolean} {
  const partsList: RawPartLike[] =
    'parts' in contentObj && Array.isArray(contentObj.parts)
      ? contentObj.parts
      : [contentObj as RawPartLike];

  const partRows: ContentPartRow[] = [];
  const summaries: string[] = [];
  let isTruncated = false;

  for (let i = 0; i < partsList.length; i++) {
    const result = parsePart(partsList[i], startPartIndex + i, maxLen);
    partRows.push(result.partRow);
    if (result.summary !== null) {
      summaries.push(result.summary);
    }
    if (result.truncated) {
      isTruncated = true;
    }
  }

  const combinedSummary = summaries.join(' | ');
  const truncatedSummary = truncateCodePoints(combinedSummary, maxLen);
  return {
    summary: truncatedSummary.value,
    parts: partRows,
    truncated: isTruncated || truncatedSummary.truncated,
  };
}

function isLlmRequestLike(val: unknown): val is RawLlmRequestLike {
  return (
    typeof val === 'object' &&
    val !== null &&
    'contents' in val &&
    Array.isArray((val as RawLlmRequestLike).contents)
  );
}

function isContentOrPartLike(
  val: unknown,
): val is RawContentLike | RawPartLike {
  if (typeof val !== 'object' || val === null) {
    return false;
  }
  return (
    'parts' in val ||
    'text' in val ||
    'inlineData' in val ||
    'fileData' in val ||
    'functionCall' in val ||
    'functionResponse' in val ||
    'executableCode' in val ||
    'codeExecutionResult' in val
  );
}

/**
 * Parses content, producing a JSON-serializable payload, content parts, and truncation state.
 */
export function parseContent(
  raw: unknown,
  maxLen: number,
): ParsedContentResult {
  if (raw === undefined || raw === null) {
    return {content: null, contentParts: [], truncated: false};
  }

  if (isLlmRequestLike(raw)) {
    let isTruncated = false;
    const contentParts: ContentPartRow[] = [];
    const messages: Array<{role: string; content: string}> = [];

    const contents = raw.contents ?? [];
    for (const c of contents) {
      const role = c.role ?? 'unknown';
      const roleTrunc = sanitizeText(role, maxLen);
      if (roleTrunc.truncated) {
        isTruncated = true;
      }
      const parsed = parseContentObject(c, maxLen, contentParts.length);
      if (parsed.truncated) {
        isTruncated = true;
      }
      contentParts.push(...parsed.parts);
      messages.push({role: roleTrunc.value, content: parsed.summary});
    }

    const payload: Record<string, unknown> = {};
    if (messages.length > 0) {
      payload['prompt'] = messages;
    }

    const sysInstruction = raw.config?.systemInstruction;
    if (sysInstruction !== undefined && sysInstruction !== null) {
      if (typeof sysInstruction === 'string') {
        const sanitized = sanitizeText(sysInstruction, maxLen);
        if (sanitized.truncated) {
          isTruncated = true;
        }
        payload['system_prompt'] = sanitized.value;
      } else if (isContentOrPartLike(sysInstruction)) {
        const parsed = parseContentObject(
          sysInstruction,
          maxLen,
          contentParts.length,
        );
        if (parsed.truncated) {
          isTruncated = true;
        }
        contentParts.push(...parsed.parts);
        payload['system_prompt'] = parsed.summary;
      }
    }

    return {content: payload, contentParts, truncated: isTruncated};
  }

  if (isContentOrPartLike(raw)) {
    const parsed = parseContentObject(raw, maxLen, 0);
    return {
      content: {text_summary: parsed.summary},
      contentParts: parsed.parts,
      truncated: parsed.truncated,
    };
  }

  if (typeof raw === 'string') {
    const sanitized = sanitizeText(raw, maxLen);
    return {
      content: sanitized.value,
      contentParts: [],
      truncated: sanitized.truncated,
    };
  }

  if (typeof raw === 'object') {
    const truncated = smartTruncate(raw, maxLen);
    return {
      content: truncated.value,
      contentParts: [],
      truncated: truncated.truncated,
    };
  }

  // Primitive scalar (number, boolean)
  return {content: raw, contentParts: [], truncated: false};
}
