/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Context, type Event, logger} from '@google/adk';
import {randomUUID} from 'node:crypto';
import {type BigQueryLoggerConfig} from './config.js';
import {type HybridContentParser} from './content_parser.js';
import {settleFormatterOutcome} from './formatter_outcome.js';
import {
  normalizeJsonNative,
  recursiveSmartTruncate,
  safeGet,
  sanitizeSensitiveText,
} from './sanitize.js';
import {
  ADK_ENVELOPE_SCHEMA_VERSION,
  type CustomMetadataAllowlist,
} from './schema.js';
import {snakeCaseKeysDeep} from './snake_case.js';
import {
  ambientIds,
  ambientParentSpanId,
  type TraceManager,
  type TraceScope,
} from './trace_manager.js';
import {
  type ContentPart,
  type EventRow,
  type EventStatus,
  type JsonObject,
  type JsonValue,
} from './types.js';

/**
 * pydantic's `model_dump()` writes every `GenerateContentResponseUsageMetadata`
 * field, unset ones as null.
 */
const USAGE_METADATA_NULLS = Object.fromEntries(
  [
    'cache_tokens_details',
    'cached_content_token_count',
    'candidates_token_count',
    'candidates_tokens_details',
    'prompt_token_count',
    'prompt_tokens_details',
    'thoughts_token_count',
    'tool_use_prompt_token_count',
    'tool_use_prompt_tokens_details',
    'total_token_count',
    'traffic_type',
  ].map((field) => [field, null]),
);

/**
 * Port of adk-python `EventData`: the structured fields a callback hands to
 * `logEvent`.
 */
export interface EventData {
  spanIdOverride?: string | null;
  parentSpanIdOverride?: string | null;
  latencyMs?: number | null;
  timeToFirstTokenMs?: number | null;
  model?: string | null;
  modelVersion?: string | null;
  usageMetadata?: unknown;
  cacheMetadata?: unknown;
  finishReason?: string | null;
  status?: EventStatus;
  errorMessage?: string | null;
  extraAttributes?: Record<string, unknown>;
  traceIdOverride?: string | null;
  sourceEvent?: Event | null;
  adkExtras?: Record<string, unknown>;
  customMetadata?: Readonly<Record<string, unknown>> | null;
}

/** The plugin settings every row is built with. */
export interface RowSettings {
  config: BigQueryLoggerConfig;
  deniedColumns: ReadonlySet<string>;
  customMetadata: CustomMetadataAllowlist;
  traces: TraceManager;
}

interface RowIds {
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
}

export interface PreparedContent {
  timestamp: Date;
  content: unknown;
  errorMessage: string | null;
  isTruncated: boolean;
  formatterFailed: boolean;
}

export interface ParsedContent {
  content: JsonValue;
  parts: Array<ContentPart>;
  isTruncated: boolean;
  parseFailed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function scopeOf(context: Context): TraceScope {
  return {
    invocationId: context.invocationId,
    branch: context.invocationContext.branch,
    functionCallId: context.functionCallId,
  };
}

/**
 * Port of `_derive_scope`: a node-shaped id (`name@run_id`, optionally
 * path-prefixed) is a node run, any other non-empty string a function call id.
 */
function deriveScope(
  isolationScope: unknown,
): {id: string; kind: string} | null {
  if (isolationScope === undefined || isolationScope === null) {
    return null;
  }
  if (typeof isolationScope !== 'string' || isolationScope === '') {
    logger.warn(
      `Unexpected isolation_scope shape: ${String(isolationScope)}; classifying as 'unknown'`,
    );
    return {id: String(isolationScope), kind: 'unknown'};
  }
  const lastSegment = isolationScope.split('/').at(-1) ?? '';
  return {
    id: isolationScope,
    kind: lastSegment.includes('@') ? 'node_run' : 'function_call',
  };
}

/**
 * Run ids parsed from a node path (`wf@1/node@2`), as adk-python's
 * `NodeInfo.run_id` / `parent_run_id` do.
 */
function nodeRunIds(path: string): {
  run_id: string;
  parent_run_id: string | null;
} {
  const segments = path === '' ? [] : path.split('/');
  return {
    run_id: segmentRunId(segments.at(-1)) ?? '',
    parent_run_id: segments.length > 1 ? segmentRunId(segments.at(-2)) : null,
  };
}

function segmentRunId(segment: string | undefined): string | null {
  if (segment === undefined) {
    return null;
  }
  const at = segment.lastIndexOf('@');
  return at === -1 ? null : segment.slice(at + 1);
}

/**
 * Trace id from the ambient OpenTelemetry span when there is one; span ids from
 * the plugin's own stack, so every `parent_span_id` names a logged row;
 * explicit overrides last.
 */
export function resolveIds({
  eventData,
  context,
  traces,
}: {
  eventData: EventData;
  context: Context;
  traces: TraceManager;
}): RowIds {
  const scope = scopeOf(context);
  let traceId: string | null = traces.getTraceId(scope);
  let {spanId, parentSpanId} = traces.getCurrentSpanAndParent(scope);

  const ambient = ambientIds();
  if (ambient !== null) {
    traceId = ambient.traceId;
    if (spanId === null) {
      spanId = ambient.spanId;
      parentSpanId = ambientParentSpanId();
    }
  }

  if (
    eventData.traceIdOverride !== undefined &&
    eventData.traceIdOverride !== null
  ) {
    traceId = eventData.traceIdOverride;
  }
  if (
    eventData.spanIdOverride !== undefined &&
    eventData.spanIdOverride !== null
  ) {
    spanId = eventData.spanIdOverride;
  }
  if (
    eventData.parentSpanIdOverride !== undefined &&
    eventData.parentSpanIdOverride !== null
  ) {
    parentSpanId = eventData.parentSpanIdOverride;
  }
  return {traceId, spanId, parentSpanId};
}

function extractLatency(eventData: EventData): JsonObject | null {
  const latency: JsonObject = {};
  if (eventData.latencyMs !== undefined && eventData.latencyMs !== null) {
    latency.total_ms = eventData.latencyMs;
  }
  if (
    eventData.timeToFirstTokenMs !== undefined &&
    eventData.timeToFirstTokenMs !== null
  ) {
    latency.time_to_first_token_ms = eventData.timeToFirstTokenMs;
  }
  return Object.keys(latency).length > 0 ? latency : null;
}

function resolveAgentLabel({
  context,
  sourceEvent,
}: {
  context: Context;
  sourceEvent: Event | null;
}): string | null {
  const agent = context.invocationContext.agent;
  if (agent !== undefined) {
    return agent.name;
  }
  return sourceEvent?.author ?? null;
}

function buildAdkEnvelope({
  context,
  sourceEvent,
}: {
  context: Context;
  sourceEvent: Event | null;
}): Record<string, unknown> {
  const adk: Record<string, unknown> = {
    schema_version: ADK_ENVELOPE_SCHEMA_VERSION,
  };
  try {
    adk.app_name = context.invocationContext.session.appName;
  } catch {
    adk.app_name = null;
  }
  if (sourceEvent === null) {
    return adk;
  }
  if (sourceEvent.id) {
    adk.source_event_id = sourceEvent.id;
  }
  const nodeInfo = sourceEvent.nodeInfo;
  if (nodeInfo !== undefined) {
    adk.node = {
      path: nodeInfo.path ?? '',
      ...nodeRunIds(nodeInfo.path ?? ''),
    };
  }
  if ('branch' in sourceEvent) {
    adk.branch = sourceEvent.branch ?? null;
  }
  if ('isolationScope' in sourceEvent) {
    adk.scope = deriveScope(sourceEvent.isolationScope);
  }
  const route = sourceEvent.route ?? safeGet(sourceEvent.actions, 'route');
  if (route !== undefined && route !== null) {
    adk.route = route;
  }
  const widgets = safeGet(sourceEvent.actions, 'renderUiWidgets');
  if (Array.isArray(widgets)) {
    adk.render_ui_widgets = widgets.map((widget) => snakeCaseKeysDeep(widget));
  }
  const rewind = safeGet(sourceEvent.actions, 'rewindBeforeInvocationId');
  if (rewind !== undefined && rewind !== null) {
    adk.rewind_before_invocation_id = rewind;
  }
  return adk;
}

function enrichAttributes({
  eventData,
  context,
  settings,
}: {
  eventData: EventData;
  context: Context;
  settings: RowSettings;
}): Record<string, unknown> {
  const {config, deniedColumns, traces} = settings;
  const attributes: Record<string, unknown> = {...eventData.extraAttributes};
  const adk = buildAdkEnvelope({
    context,
    sourceEvent: eventData.sourceEvent ?? null,
  });
  for (const [key, value] of Object.entries(eventData.adkExtras ?? {})) {
    if (!(key in adk)) {
      adk[key] = value;
    }
  }
  attributes.adk = adk;
  attributes.root_agent_name = traces.getRootAgentName(context.invocationId);
  if (eventData.model) {
    attributes.model = eventData.model;
  }
  if (eventData.modelVersion) {
    attributes.model_version = eventData.modelVersion;
  }
  if (eventData.usageMetadata) {
    const usage = snakeCaseKeysDeep(eventData.usageMetadata);
    const {value} = recursiveSmartTruncate({
      value: isRecord(usage) ? {...USAGE_METADATA_NULLS, ...usage} : usage,
      maxLen: config.maxContentLength,
    });
    attributes.usage_metadata = value;
  }
  if (eventData.cacheMetadata) {
    const {value} = recursiveSmartTruncate({
      value: snakeCaseKeysDeep(eventData.cacheMetadata),
      maxLen: config.maxContentLength,
    });
    attributes.cache_metadata = value;
  }
  if (eventData.finishReason !== undefined && eventData.finishReason !== null) {
    attributes.finish_reason = eventData.finishReason;
  }
  if (config.logSessionMetadata) {
    try {
      const session = context.invocationContext.session;
      const sessionMeta: Record<string, unknown> = {
        session_id: session.id,
        app_name: session.appName,
        user_id: session.userId,
      };
      if (Object.keys(session.state).length > 0) {
        sessionMeta.state = recursiveSmartTruncate({
          value: {...session.state},
          maxLen: config.maxContentLength,
        }).value;
      }
      attributes.session_metadata = sessionMeta;
    } catch {
      // Session metadata is best-effort enrichment; a row is still written
      // without it.
    }
  }
  if (Object.keys(config.customTags).length > 0) {
    attributes.custom_tags = config.customTags;
  }
  if (config.enableOtelCorrelation && !deniedColumns.has('attributes')) {
    const ambient = ambientIds();
    if (ambient !== null) {
      attributes.otel = {span_id: ambient.spanId, trace_id: ambient.traceId};
    }
  }
  return attributes;
}

/**
 * Captures allowlisted custom metadata into `attributes.custom_metadata`; true
 * when it was truncated.
 */
function captureCustomMetadata({
  eventData,
  attributes,
  settings,
}: {
  eventData: EventData;
  attributes: Record<string, unknown>;
  settings: RowSettings;
}): boolean {
  const {exact, prefixes} = settings.customMetadata;
  const meta =
    eventData.customMetadata ?? eventData.sourceEvent?.customMetadata ?? null;
  if (meta === null) {
    return false;
  }
  const captured = Object.fromEntries(
    Object.entries(meta).filter(
      ([key]) =>
        exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix)),
    ),
  );
  if (Object.keys(captured).length === 0) {
    return false;
  }
  const {value, isTruncated} = recursiveSmartTruncate({
    value: captured,
    maxLen: settings.config.maxContentLength,
  });
  if (isRecord(value) && Object.keys(value).length > 0) {
    attributes.custom_metadata = value;
  }
  return isTruncated;
}

function redactErrorMessage({
  message,
  maxLen,
}: {
  message: string;
  maxLen: number;
}): {
  text: string;
  isTruncated: boolean;
} {
  try {
    return sanitizeSensitiveText({text: message, maxLen});
  } catch {
    return {text: '[REDACTED_SENSITIVE_TEXT]', isTruncated: true};
  }
}

/** Redacts an error event's traceback in place of the raw one. */
function redactTraceback({
  eventType,
  content,
  maxLen,
}: {
  eventType: string;
  content: unknown;
  maxLen: number;
}): {
  content: unknown;
  isTruncated: boolean;
} {
  if (
    (eventType !== 'AGENT_ERROR' && eventType !== 'INVOCATION_ERROR') ||
    !isRecord(content)
  ) {
    return {content, isTruncated: false};
  }
  try {
    const traceback = content.error_traceback;
    if (typeof traceback !== 'string') {
      return {content, isTruncated: false};
    }
    const safe = sanitizeSensitiveText({text: traceback, maxLen});
    return {
      content: {...content, error_traceback: safe.text},
      isTruncated: safe.isTruncated,
    };
  } catch {
    return {
      content: {error_traceback: '[REDACTED_SENSITIVE_TEXT]'},
      isTruncated: true,
    };
  }
}

/**
 * Redaction and the configured content formatter, both fail-closed: a failure
 * writes a sentinel, never the original content.
 */
export function prepareContent({
  eventType,
  rawContent,
  isTruncated,
  eventData,
  config,
}: {
  eventType: string;
  rawContent: unknown;
  isTruncated: boolean;
  eventData: EventData;
  config: BigQueryLoggerConfig;
}): PreparedContent {
  const maxLen = config.maxContentLength;
  const redactedMessage =
    eventData.errorMessage === undefined || eventData.errorMessage === null
      ? null
      : redactErrorMessage({message: eventData.errorMessage, maxLen});
  const redacted = redactTraceback({eventType, content: rawContent, maxLen});
  const timestamp = new Date();

  let content = redacted.content;
  let formatterError: string | null = null;
  if (config.contentFormatter !== null) {
    let formatted: unknown = null;
    let failure: unknown = null;
    try {
      formatted = config.contentFormatter(content, eventType);
    } catch (error) {
      // settleFormatterOutcome reads a nullish failure as "the formatter
      // returned".
      failure = error ?? new Error('content_formatter threw a nullish value');
    }
    const settled = settleFormatterOutcome({
      formatted,
      failure,
      eventType,
      debug: config.debugContentFormatterErrors,
    });
    content = settled.content;
    formatterError = settled.errorMessage;
  }

  let errorMessage = redactedMessage?.text ?? null;
  if (formatterError !== null) {
    errorMessage = errorMessage
      ? `${errorMessage}; ${formatterError}`
      : formatterError;
  }
  return {
    timestamp,
    content,
    errorMessage,
    isTruncated:
      isTruncated ||
      (redactedMessage?.isTruncated ?? false) ||
      redacted.isTruncated,
    formatterFailed: formatterError !== null,
  };
}

/**
 * Parses content into the `content` JSON and `content_parts`, writing a
 * sentinel when parsing fails.
 */
export async function parseContent({
  eventType,
  content,
  ids,
  parser,
  settings,
}: {
  eventType: string;
  content: unknown;
  ids: RowIds;
  parser: HybridContentParser;
  settings: RowSettings;
}): Promise<ParsedContent> {
  const {deniedColumns, config} = settings;
  if (deniedColumns.has('content') && deniedColumns.has('content_parts')) {
    return {content: null, parts: [], isTruncated: false, parseFailed: false};
  }
  try {
    const parsed = await parser.parse(content, {
      traceId: ids.traceId ?? 'no_trace',
      spanId: ids.spanId ?? 'no_span',
    });
    const normalizedContent = normalizeJsonNative({
      value: parsed.payload,
      maxLen: config.maxContentLength,
    });
    const normalizedParts = normalizeJsonNative({
      value: parsed.parts,
      maxLen: -1,
    });
    return {
      content: normalizedContent.value,
      parts: Array.isArray(normalizedParts.value) ? parsed.parts : [],
      isTruncated:
        parsed.isTruncated ||
        normalizedContent.isTruncated ||
        normalizedParts.isTruncated,
      parseFailed: false,
    };
  } catch {
    logger.warn(
      `Content parsing failed for event ${eventType}; writing sentinel instead of content.`,
    );
    return {
      content: '[CONTENT_PARSE_FAILED]',
      parts: [],
      isTruncated: true,
      parseFailed: true,
    };
  }
}

/**
 * Assembles the row, leaving out every column `payloadColumnDenylist` projects
 * away.
 */
export function buildEventRow({
  eventType,
  context,
  eventData,
  ids,
  prepared,
  parsed,
  settings,
}: {
  eventType: string;
  context: Context;
  eventData: EventData;
  ids: RowIds;
  prepared: PreparedContent;
  parsed: ParsedContent;
  settings: RowSettings;
}): EventRow {
  const {config, deniedColumns, customMetadata} = settings;
  const enriched = enrichAttributes({eventData, context, settings});
  const metadataTruncated =
    customMetadata.exact.size > 0 || customMetadata.prefixes.length > 0
      ? captureCustomMetadata({eventData, attributes: enriched, settings})
      : false;
  const finalAttributes = recursiveSmartTruncate({
    value: enriched,
    maxLen: config.maxContentLength,
  });
  const attributes = isRecord(finalAttributes.value)
    ? finalAttributes.value
    : {};

  const row: EventRow = {
    timestamp: prepared.timestamp,
    event_id: randomUUID().replaceAll('-', ''),
    event_type: eventType,
    agent: resolveAgentLabel({
      context,
      sourceEvent: eventData.sourceEvent ?? null,
    }),
    user_id: context.invocationContext.session.userId,
    session_id: context.invocationContext.session.id,
    invocation_id: context.invocationId,
    trace_id: ids.traceId,
    span_id: ids.spanId,
    parent_span_id: ids.parentSpanId,
    status: eventData.status ?? 'OK',
    error_message: prepared.errorMessage,
    is_truncated:
      prepared.isTruncated ||
      parsed.isTruncated ||
      metadataTruncated ||
      finalAttributes.isTruncated,
  };
  if (!deniedColumns.has('content')) {
    row.content = parsed.content;
  }
  if (!deniedColumns.has('content_parts')) {
    row.content_parts = config.logMultiModalContent ? parsed.parts : [];
  }
  if (!deniedColumns.has('attributes')) {
    row.attributes = JSON.stringify(attributes);
  }
  if (!deniedColumns.has('latency_ms')) {
    row.latency_ms = extractLatency(eventData);
  }
  return row;
}
