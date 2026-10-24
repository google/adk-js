/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type LlmRequest} from '@google/adk';
import {type Content, type Part} from '@google/genai';
import {randomUUID} from 'node:crypto';
import {FORMATTER_FAILED_SENTINEL} from './formatter_outcome.js';
import {type GcsOffloader} from './gcs_offloader.js';
import {pythonJsonDumps, pythonJsonLoads} from './python_json.js';
import {
  exceedsCodePoints,
  parseQueryPairs,
  percentEncode,
  sliceCodePoints,
  type UrlParts,
  urlSplit,
  urlUnsplit,
} from './python_strings.js';
import {
  canonicalizeCommonAsciiEscapes,
  containsSensitiveTextMarker,
  enumLabel,
  isSensitiveKey,
  MAX_JSON_INSPECT_CHARS,
  MAX_SANITIZE_DEPTH,
  MAX_SANITIZE_NODES,
  recursiveSmartTruncate,
  sanitizeSensitiveText,
  stripBomWs,
} from './sanitize.js';
import {snakeCaseKeysDeep} from './snake_case.js';
import {
  type ContentPart,
  type JsonObject,
  type JsonValue,
  type ObjectRef,
} from './types.js';

const TRUNCATION_MARKER = '...[TRUNCATED]';
const REDACTED = '[REDACTED]';
const REDACTED_URI = '[REDACTED_SENSITIVE_URI]';
const UNSUPPORTED_OBJECT = '[UNSUPPORTED_OBJECT]';
const BUDGET_EXCEEDED = '[SANITIZE_BUDGET_EXCEEDED]';
const INLINE_TEXT_BYTE_LIMIT = 32 * 1024;
const OFFLOAD_PREVIEW_CHARS = 200;

/**
 * Text after sanitizing or truncation; `isTruncated` is true when any content
 * was lost or replaced.
 */
export interface TextResult {
  text: string;
  isTruncated: boolean;
}

export interface ParseResult {
  payload: JsonValue;
  parts: Array<ContentPart>;
  isTruncated: boolean;
}

interface ParsedContentObject {
  summary: string;
  parts: Array<ContentPart>;
  isTruncated: boolean;
}

interface ParsedPart {
  part: ContentPart;
  summary: string | null;
  isTruncated: boolean;
}

interface ParseIdentity {
  traceId: string;
  spanId: string;
  parseUid: string;
  contentOrdinal: number;
}

interface SerializedPartModel {
  value: JsonObject;
  isTruncated: boolean;
}

interface SanitizedJson {
  value: JsonValue;
  replaced: boolean;
}

interface Offloaded {
  uri: string;
  objectRef: ObjectRef;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function read(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Python's `str()` for the scalars a payload can carry. */
function pyStr(
  value: string | number | bigint | boolean | null | undefined,
): string {
  if (value === undefined || value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}

/**
 * `str()` of a non-object payload; symbols and functions have no stable Python
 * rendering.
 */
function scalarText(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return typeof value === 'string' ? value : pyStr(value);
  }
  return UNSUPPORTED_OBJECT;
}

function truncate(text: string, maxLength: number): TextResult {
  return exceedsCodePoints(text, maxLength)
    ? {
        text: sliceCodePoints(text, maxLength) + TRUNCATION_MARKER,
        isTruncated: true,
      }
    : {text, isTruncated: false};
}

/**
 * Port of `_format_content`: a one-line summary of an Event's content for
 * logging.
 */
export function formatContent({
  content,
  maxLen = 5000,
}: {
  content: Content | undefined;
  maxLen?: number;
}): TextResult {
  // Keep these prefixes and the " | " delimiter in sync with the eval views'
  // response_events CTE.
  const parts = content?.parts ?? [];
  if (parts.length === 0) {
    return {text: 'None', isTruncated: false};
  }
  let isTruncated = false;
  function sanitize(text: string): string {
    const sanitized = sanitizeSensitiveText({text, maxLen});
    isTruncated ||= sanitized.isTruncated;
    return sanitized.text;
  }
  const rendered = parts.map((part) => {
    if (part.text) {
      return `text: '${sanitize(part.text)}'`;
    }
    if (part.functionCall) {
      return `call: ${pyStr(part.functionCall.name)}`;
    }
    if (part.functionResponse) {
      return `resp: ${pyStr(part.functionResponse.name)}`;
    }
    if (part.executableCode) {
      return `Executable code (${enumLabel(part.executableCode.language)}): ${sanitize(part.executableCode.code ?? '')}`;
    }
    if (part.codeExecutionResult) {
      return `Code execution result (${enumLabel(part.codeExecutionResult.outcome)}): ${sanitize(part.codeExecutionResult.output ?? '')}`;
    }
    return 'other';
  });
  return {text: rendered.join(' | '), isTruncated};
}

// Python mimetypes.guess_extension for the media types models exchange;
// anything else is .bin.
const MIME_EXTENSIONS = new Map([
  ['application/json', '.json'],
  ['application/octet-stream', '.bin'],
  ['application/pdf', '.pdf'],
  ['application/zip', '.zip'],
  ['audio/aac', '.aac'],
  ['audio/flac', '.flac'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['image/bmp', '.bmp'],
  ['image/gif', '.gif'],
  ['image/heic', '.heic'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/svg+xml', '.svg'],
  ['image/tiff', '.tiff'],
  ['image/webp', '.webp'],
  ['text/csv', '.csv'],
  ['text/html', '.html'],
  ['text/markdown', '.md'],
  ['text/plain', '.txt'],
  ['text/xml', '.xml'],
  ['video/mp4', '.mp4'],
  ['video/mpeg', '.mpeg'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
]);

function guessExtension(mimeType: string): string {
  return MIME_EXTENSIONS.get(mimeType.toLowerCase()) ?? '.bin';
}

function localDate(): string {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

const PART_FIELDS = new Set([
  'audioTranscription',
  'codeExecutionResult',
  'executableCode',
  'fileData',
  'functionCall',
  'functionResponse',
  'inlineData',
  'mediaProcessing',
  'mediaResolution',
  'partMetadata',
  'speechMetadata',
  'text',
  'thought',
  'thoughtSignature',
  'toolCall',
  'toolResponse',
  'videoMetadata',
]);

/**
 * genai Parts are plain objects, so a non-empty record whose keys are all Part
 * fields is treated as one.
 */
function isPart(value: unknown): value is Part {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => PART_FIELDS.has(key))
  );
}

function isContent(value: unknown): value is Content {
  return (
    isRecord(value) &&
    Array.isArray(value.parts) &&
    Object.keys(value).every((key) => key === 'parts' || key === 'role') &&
    value.parts.every((part) => isPart(part))
  );
}

function isLlmRequest(value: unknown): value is LlmRequest {
  return (
    isRecord(value) &&
    Array.isArray(value.contents) &&
    isRecord(value.toolsDict)
  );
}

function rawPartsOf(content: unknown): Array<unknown> {
  if (isContent(content)) {
    return content.parts ?? [];
  }
  return Array.isArray(content) ? content : [content];
}

function emptyPart(index: number): ContentPart {
  return {
    part_index: index,
    mime_type: 'text/plain',
    uri: null,
    text: null,
    part_attributes: '{}',
    storage_mode: 'INLINE',
    object_ref: null,
  };
}

function stringField(
  value: JsonValue | undefined,
  fallback: string,
): TextResult {
  const field = value || fallback;
  return typeof field === 'string'
    ? {text: field, isTruncated: false}
    : {text: UNSUPPORTED_OBJECT, isTruncated: true};
}

/**
 * Parses content for logging, offloading large text and binary parts to GCS
 * when an offloader is set.
 */
export class HybridContentParser {
  readonly traceId: string;
  readonly spanId: string;
  private readonly offloader: GcsOffloader | null;
  private readonly maxLength: number;
  private readonly connectionId: string | null;

  constructor({
    offloader,
    traceId,
    spanId,
    maxLength = 20_000,
    connectionId = null,
  }: {
    offloader: GcsOffloader | null;
    traceId: string;
    spanId: string;
    maxLength?: number;
    connectionId?: string | null;
  }) {
    this.offloader = offloader;
    this.traceId = traceId;
    this.spanId = spanId;
    this.maxLength = maxLength;
    this.connectionId = connectionId;
  }

  /**
   * Port of `HybridContentParser.parse`. Pass the calling event's ids per call:
   * the parser is shared across concurrent events, so instance fields would let
   * one event's GCS objects land under another's path.
   */
  async parse(
    content: unknown,
    ids: {traceId?: string; spanId?: string} = {},
  ): Promise<ParseResult> {
    const traceId = ids.traceId ?? this.traceId;
    const spanId = ids.spanId ?? this.spanId;
    const parseUid = randomUUID().replaceAll('-', '');

    if (isLlmRequest(content)) {
      return this.parseLlmRequest(content, {traceId, spanId, parseUid});
    }
    if (isContent(content) || isPart(content)) {
      const parsed = await this.parseContentObject(content, {
        traceId,
        spanId,
        parseUid,
        contentOrdinal: 0,
      });
      return {
        payload: {text_summary: parsed.summary},
        parts: parsed.parts,
        isTruncated: parsed.isTruncated,
      };
    }
    if (typeof content === 'object' && content !== null) {
      const truncated = recursiveSmartTruncate({
        value: content,
        maxLen: this.maxLength,
      });
      return {
        payload: truncated.value,
        parts: [],
        isTruncated: truncated.isTruncated,
      };
    }
    if (content === null || content === undefined) {
      return {payload: null, parts: [], isTruncated: false};
    }
    const processed = this.sanitizeAndTruncate(scalarText(content));
    return {
      payload: processed.text,
      parts: [],
      isTruncated: processed.isTruncated,
    };
  }

  private async parseLlmRequest(
    request: LlmRequest,
    identity: Omit<ParseIdentity, 'contentOrdinal'>,
  ): Promise<ParseResult> {
    const messages = await Promise.all(
      request.contents.map(async (message, contentOrdinal) => {
        const role = this.sanitizeAndTruncate(message.role || 'unknown');
        const parsed = await this.parseContentObject(message, {
          ...identity,
          contentOrdinal,
        });
        return {role, parsed};
      }),
    );
    const payload: JsonObject = {};
    const parts = messages.flatMap(({parsed}) => parsed.parts);
    let isTruncated = messages.some(
      ({role, parsed}) => role.isTruncated || parsed.isTruncated,
    );
    if (messages.length > 0) {
      payload.prompt = messages.map(({role, parsed}) => ({
        role: role.text,
        content: parsed.summary,
      }));
    }
    const systemInstruction = request.config?.systemInstruction;
    if (typeof systemInstruction === 'string') {
      if (systemInstruction !== '') {
        const processed = this.sanitizeAndTruncate(systemInstruction);
        payload.system_prompt = processed.text;
        isTruncated ||= processed.isTruncated;
      }
      return {payload, parts, isTruncated};
    }
    if (
      systemInstruction === undefined ||
      (Array.isArray(systemInstruction) && systemInstruction.length === 0)
    ) {
      return {payload, parts, isTruncated};
    }
    const parsed = await this.parseContentObject(systemInstruction, {
      ...identity,
      contentOrdinal: request.contents.length,
    });
    payload.system_prompt = parsed.summary;
    return {
      payload,
      parts: [...parts, ...parsed.parts],
      isTruncated: isTruncated || parsed.isTruncated,
    };
  }

  /**
   * Sanitizes caller text once before it is stored inline or uploaded.
   * Bracketed prose that merely fails to parse as JSON is restored when it
   * carries no credential construct; malformed credential documents stay
   * redacted.
   */
  private sanitizeRawText(text: string): TextResult {
    if (text === FORMATTER_FAILED_SENTINEL || text === REDACTED) {
      return {text, isTruncated: false};
    }
    const {value: sanitized, isTruncated} = recursiveSmartTruncate({
      value: text,
      maxLen: -1,
    });
    if (sanitized === '[UNPARSEABLE_JSON_BLOB]') {
      const stripped = stripBomWs(text);
      if (
        stripped.length <= MAX_JSON_INSPECT_CHARS &&
        (stripped.startsWith('[') || stripped.startsWith('{')) &&
        !containsSensitiveTextMarker(stripped)
      ) {
        try {
          pythonJsonLoads(stripped);
        } catch {
          return {text, isTruncated: false};
        }
      }
    }
    if (typeof sanitized !== 'string') {
      return {text: UNSUPPORTED_OBJECT, isTruncated: true};
    }
    return {text: sanitized, isTruncated};
  }

  private sanitizeAndTruncate(text: string): TextResult {
    const sanitized = this.sanitizeRawText(text);
    const truncated = truncate(sanitized.text, this.maxLength);
    return {
      text: truncated.text,
      isTruncated: sanitized.isTruncated || truncated.isTruncated,
    };
  }

  /** Redacts signed or query credentials while keeping the URI's location. */
  private sanitizeExternalUri(uri: string | undefined): TextResult {
    if (typeof uri !== 'string' || uri.length > MAX_JSON_INSPECT_CHARS) {
      return {text: REDACTED_URI, isTruncated: true};
    }
    let parsed: UrlParts;
    let query: Array<[string, string]>;
    try {
      parsed = urlSplit(uri);
      query = parseQueryPairs(parsed.query);
    } catch {
      return {text: REDACTED_URI, isTruncated: true};
    }
    // Userinfo is a credential surface by definition; no attempt to keep a
    // username.
    if (parsed.netloc.includes('@')) {
      return {text: REDACTED_URI, isTruncated: true};
    }

    let changed = false;
    let redactNext = false;
    const pathSegments = parsed.path.split('/').map((segment) => {
      if (segment === '') {
        return segment;
      }
      if (
        redactNext ||
        isSensitiveKey(canonicalizeCommonAsciiEscapes(segment))
      ) {
        redactNext = !redactNext;
        changed = true;
        return percentEncode(REDACTED, false);
      }
      const safe = sanitizeSensitiveText({text: segment, maxLen: -1});
      changed ||= safe.isTruncated;
      return safe.isTruncated ? percentEncode(safe.text, false) : segment;
    });

    const safeQuery = query.map(([key, value]) => {
      if (isSensitiveKey(key)) {
        changed = true;
        return `${percentEncode(key, true)}=${percentEncode(REDACTED, true)}`;
      }
      const safeKey = sanitizeSensitiveText({text: key, maxLen: -1});
      const safeValue = sanitizeSensitiveText({text: value, maxLen: -1});
      changed ||= safeKey.isTruncated || safeValue.isTruncated;
      return `${percentEncode(safeKey.text, true)}=${percentEncode(safeValue.text, true)}`;
    });

    const safeFragment = sanitizeSensitiveText({
      text: parsed.fragment,
      maxLen: -1,
    });
    changed ||= safeFragment.isTruncated;
    const truncated = truncate(
      urlUnsplit({
        scheme: parsed.scheme,
        netloc: parsed.netloc,
        path: pathSegments.join('/'),
        query: safeQuery.join('&'),
        fragment: safeFragment.text,
      }),
      this.maxLength,
    );
    return {
      text: truncated.text,
      isTruncated: changed || truncated.isTruncated,
    };
  }

  /**
   * Bounded, redacted JSON-native fields for a structured part, keyed as
   * Python's `model_dump` writes them.
   */
  private serializePartModel(dumped: unknown): SerializedPartModel {
    const truncated = recursiveSmartTruncate({
      value: dumped,
      maxLen: this.maxLength,
    });
    if (!isRecord(truncated.value)) {
      return {value: {value: UNSUPPORTED_OBJECT}, isTruncated: true};
    }
    const sanitized = sanitizePartStrings(truncated.value, this.maxLength);
    if (!isRecord(sanitized.value)) {
      return {value: {value: UNSUPPORTED_OBJECT}, isTruncated: true};
    }
    return {
      value: sanitized.value,
      isTruncated: truncated.isTruncated || sanitized.replaced,
    };
  }

  private async offload({
    data,
    contentType,
    path,
  }: {
    data: Buffer | string;
    contentType: string;
    path: string;
  }): Promise<Offloaded> {
    if (this.offloader === null) {
      throw new Error('no offloader');
    }
    const uri = await this.offloader.uploadContent({data, contentType, path});
    return {
      uri,
      objectRef: {
        uri,
        version: null,
        authorizer: this.connectionId,
        details: pythonJsonDumps({gcs_metadata: {content_type: contentType}}),
      },
    };
  }

  /**
   * Port of `_parse_content_object`. `parseUid` (unique per parse) and
   * `contentOrdinal` keep GCS object names distinct across the messages of one
   * request, whose part indexes each restart at zero.
   */
  private async parseContentObject(
    content: unknown,
    identity: ParseIdentity,
  ): Promise<ParsedContentObject> {
    const parsedParts = await Promise.all(
      rawPartsOf(content).map(async (rawPart, index) =>
        // A bare string or any other ContentUnion member carries no part fields
        // and contributes an empty entry.
        this.parsePart(isPart(rawPart) ? rawPart : {}, index, identity),
      ),
    );
    const summary = parsedParts.flatMap((parsed) =>
      parsed.summary === null ? [] : [parsed.summary],
    );
    const joined = truncate(summary.join(' | '), this.maxLength);
    return {
      summary: joined.text,
      parts: parsedParts.map((parsed) => parsed.part),
      isTruncated:
        joined.isTruncated || parsedParts.some((parsed) => parsed.isTruncated),
    };
  }

  private objectPath(
    {traceId, spanId, parseUid, contentOrdinal}: ParseIdentity,
    index: number,
    extension: string,
  ): string {
    return `${localDate()}/${traceId}/${spanId}_${parseUid}_c${contentOrdinal}_p${index}${extension}`;
  }

  private async parsePart(
    part: Part,
    index: number,
    identity: ParseIdentity,
  ): Promise<ParsedPart> {
    const partData = emptyPart(index);

    if (part.fileData) {
      const safeUri = this.sanitizeExternalUri(part.fileData.fileUri);
      return {
        part: {
          ...partData,
          storage_mode: 'EXTERNAL_URI',
          uri: safeUri.text,
          mime_type: part.fileData.mimeType ?? null,
        },
        summary: null,
        isTruncated: safeUri.isTruncated,
      };
    }
    if (part.inlineData) {
      return {
        part: await this.parseInlineData(part.inlineData, partData, identity),
        summary: null,
        isTruncated: false,
      };
    }
    if (part.text) {
      return this.parseText(part.text, partData, identity);
    }
    if (part.functionCall) {
      return {
        part: {
          ...partData,
          mime_type: 'application/json',
          text: `Function: ${pyStr(part.functionCall.name)}`,
          part_attributes: pythonJsonDumps({
            function_name: part.functionCall.name ?? null,
          }),
        },
        summary: null,
        isTruncated: false,
      };
    }
    if (part.functionResponse) {
      const {response, parts: responseParts, ...model} = part.functionResponse;
      const modelFields = snakeCaseKeysDeep(model);
      const dumped: Record<string, unknown> = isRecord(modelFields)
        ? {...modelFields}
        : {};
      if (response !== undefined) {
        dumped.response = response;
      }
      if (responseParts !== undefined) {
        dumped.parts = snakeCaseKeysDeep(responseParts);
      }
      const serialized = this.serializePartModel(dumped);
      const name = stringField(serialized.value.name, 'unknown');
      const responseSummary = `Function response: ${name.text}`;
      return {
        part: {
          ...partData,
          mime_type: 'application/json',
          text: responseSummary,
          part_attributes: pythonJsonDumps({
            function_response: serialized.value,
          }),
        },
        summary: responseSummary,
        isTruncated: serialized.isTruncated || name.isTruncated,
      };
    }
    if (part.executableCode) {
      const serialized = this.serializePartModel(
        snakeCaseKeysDeep(part.executableCode),
      );
      const language = stringField(serialized.value.language, 'unknown');
      const code = stringField(serialized.value.code, '');
      return {
        part: {
          ...partData,
          text: code.text,
          part_attributes: pythonJsonDumps({executable_code: serialized.value}),
        },
        summary: `Executable code (${language.text}): ${code.text}`,
        isTruncated:
          serialized.isTruncated || language.isTruncated || code.isTruncated,
      };
    }
    if (part.codeExecutionResult) {
      const serialized = this.serializePartModel(
        snakeCaseKeysDeep(part.codeExecutionResult),
      );
      const outcome = stringField(serialized.value.outcome, 'unknown');
      const output = stringField(serialized.value.output, '');
      return {
        part: {
          ...partData,
          text: output.text,
          part_attributes: pythonJsonDumps({
            code_execution_result: serialized.value,
          }),
        },
        summary: `Code execution result (${outcome.text}): ${output.text}`,
        isTruncated:
          serialized.isTruncated || outcome.isTruncated || output.isTruncated,
      };
    }
    return {part: partData, summary: null, isTruncated: false};
  }

  private async parseInlineData(
    inlineData: NonNullable<Part['inlineData']>,
    partData: ContentPart,
    identity: ParseIdentity,
  ): Promise<ContentPart> {
    if (this.offloader === null) {
      return {...partData, text: '[BINARY DATA]'};
    }
    const mimeType = inlineData.mimeType || 'application/octet-stream';
    try {
      const {uri, objectRef} = await this.offload({
        data: Buffer.from(inlineData.data ?? '', 'base64'),
        contentType: mimeType,
        path: this.objectPath(
          identity,
          partData.part_index ?? 0,
          guessExtension(mimeType),
        ),
      });
      return {
        ...partData,
        storage_mode: 'GCS_REFERENCE',
        uri,
        object_ref: objectRef,
        mime_type: mimeType,
        text: '[MEDIA OFFLOADED]',
      };
    } catch (error) {
      console.warn('Failed to offload content to GCS:', error);
      return {...partData, text: '[UPLOAD FAILED]'};
    }
  }

  private async parseText(
    text: string,
    partData: ContentPart,
    identity: ParseIdentity,
  ): Promise<ParsedPart> {
    const safe = this.sanitizeRawText(text);
    // The byte limit guards row storage; maxLength is a character limit. Each
    // is checked in its own unit.
    const exceedsInlineBytes =
      Buffer.byteLength(safe.text, 'utf8') > INLINE_TEXT_BYTE_LIMIT;
    if (
      this.offloader !== null &&
      (exceedsInlineBytes || exceedsCodePoints(safe.text, this.maxLength))
    ) {
      try {
        const {uri, objectRef} = await this.offload({
          data: safe.text,
          contentType: 'text/plain',
          path: this.objectPath(identity, partData.part_index ?? 0, '.txt'),
        });
        return {
          part: {
            ...partData,
            storage_mode: 'GCS_REFERENCE',
            uri,
            object_ref: objectRef,
            mime_type: 'text/plain',
            text: `${sliceCodePoints(safe.text, OFFLOAD_PREVIEW_CHARS)}... [OFFLOADED]`,
          },
          summary: null,
          isTruncated: safe.isTruncated,
        };
      } catch (error) {
        console.warn('Failed to offload text to GCS:', error);
      }
    }
    const clean = truncate(safe.text, this.maxLength);
    return {
      part: {...partData, text: clean.text},
      summary: clean.text,
      isTruncated: safe.isTruncated || clean.isTruncated,
    };
  }
}

/**
 * Port of `_serialize_part_model`'s string walk: redacts keys and strings,
 * renaming colliding keys.
 */
function sanitizePartStrings(
  root: JsonValue,
  maxLength: number,
): SanitizedJson {
  let budget = MAX_SANITIZE_NODES;

  function walkObject(
    value: {[key: string]: JsonValue},
    depth: number,
  ): SanitizedJson {
    const out: JsonObject = {};
    let replaced = false;
    let collisionCount = 0;
    function collisionSafeKey(key: string): string {
      if (!Object.hasOwn(out, key)) {
        return key;
      }
      let candidate: string;
      do {
        collisionCount += 1;
        candidate = `[KEY_COLLISION_${collisionCount}]${key}`;
      } while (Object.hasOwn(out, candidate));
      replaced = true;
      return candidate;
    }
    for (const [key, item] of Object.entries(value)) {
      if (budget <= 0) {
        out[collisionSafeKey(BUDGET_EXCEEDED)] = BUDGET_EXCEEDED;
        return {value: out, replaced: true};
      }
      const redactItem = isSensitiveKey(canonicalizeCommonAsciiEscapes(key));
      const safeKey = sanitizeSensitiveText({text: key, maxLen: maxLength});
      const outKey = collisionSafeKey(safeKey.text);
      const sanitized: SanitizedJson = redactItem
        ? {value: REDACTED, replaced: item !== REDACTED}
        : walk(item, depth + 1);
      out[outKey] = sanitized.value;
      replaced ||= safeKey.isTruncated || sanitized.replaced;
    }
    return {value: out, replaced};
  }

  function walk(value: JsonValue, depth: number): SanitizedJson {
    budget -= 1;
    if (budget < 0 || depth >= MAX_SANITIZE_DEPTH) {
      return {value: BUDGET_EXCEEDED, replaced: true};
    }
    if (typeof value === 'string') {
      const sanitized = sanitizeSensitiveText({text: value, maxLen: maxLength});
      return {value: sanitized.text, replaced: sanitized.isTruncated};
    }
    if (Array.isArray(value)) {
      const items: Array<JsonValue> = [];
      let replaced = false;
      for (const item of value) {
        if (budget <= 0) {
          return {value: [...items, BUDGET_EXCEEDED], replaced: true};
        }
        const sanitized = walk(item, depth + 1);
        items.push(sanitized.value);
        replaced ||= sanitized.replaced;
      }
      return {value: items, replaced};
    }
    if (value === null || typeof value !== 'object') {
      return {value, replaced: false};
    }
    return walkObject(value, depth);
  }

  return walk(root, 0);
}
