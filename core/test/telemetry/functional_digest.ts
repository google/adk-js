/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A deterministic digest of the spans and log records one scenario run
 * produced, in the shape of the functional telemetry goldens.
 *
 * Generated ids collapse to `PRESENT`, JSON-encoded GenAI attributes are
 * parsed, null object entries are dropped, children follow start order and
 * each log record hangs on the span it was emitted under.
 */

import {type Context, SpanStatusCode} from '@opentelemetry/api';
import type {ReadableLogRecord} from '@opentelemetry/sdk-logs';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/** Sentinel for a value that cannot be pinned, such as a generated id. */
export const PRESENT = 'PRESENT';

/** Attribute keys whose values are generated, so only presence is checked. */
const NON_DETERMINISTIC_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'gcp.vertex.agent.event_id',
  'gen_ai.tool.call.id',
  'gcp.vertex.agent.associated_event_ids',
  'gen_ai.conversation.id',
  'gcp.vertex.agent.invocation_id',
  'gcp.vertex.agent.session_id',
  'gen_ai.compaction.result_event_id',
  'gen_ai.compaction.start_timestamp',
  'gen_ai.compaction.end_timestamp',
]);

/** Payload object keys that carry a generated id. */
const NON_DETERMINISTIC_PAYLOAD_FIELDS: ReadonlySet<string> = new Set(['id']);

/** Span attribute keys whose string values are JSON documents. */
const JSON_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]);

/** A digest of one log record. */
export interface LogDigest {
  event_name: string;
  body: unknown;
  attributes: Record<string, unknown>;
}

/** A digest of one span, its log records and its children. */
export interface SpanDigest {
  name: string;
  attributes: Record<string, unknown>;
  status: 'UNSET' | 'OK' | 'ERROR';
  children: SpanDigest[];
  logs: LogDigest[];
}

/**
 * Records the order spans start in, because two spans can share an hrtime
 * start value.
 */
export class StartOrderSpanProcessor implements SpanProcessor {
  private readonly order = new Map<string, number>();
  private next = 0;

  onStart(span: Span, _parentContext: Context): void {
    this.order.set(span.spanContext().spanId, this.next++);
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /** Returns the start position of a span, or infinity when it is unknown. */
  positionOf(spanId: string): number {
    return this.order.get(spanId) ?? Number.POSITIVE_INFINITY;
  }

  /** Forgets every recorded span. */
  reset(): void {
    this.order.clear();
    this.next = 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a value for stable equality: arrays stay arrays, object entries
 * whose value is null or undefined are dropped, and an object key `id`
 * collapses to {@link PRESENT}.
 */
export function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) {
        continue;
      }
      normalized[key] = NON_DETERMINISTIC_PAYLOAD_FIELDS.has(key)
        ? PRESENT
        : normalizeValue(item);
    }
    return normalized;
  }
  return value;
}

function normalizeLogAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    normalized[key] = NON_DETERMINISTIC_ATTRIBUTE_KEYS.has(key)
      ? PRESENT
      : normalizeValue(value);
  }
  return normalized;
}

function normalizeSpanAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (NON_DETERMINISTIC_ATTRIBUTE_KEYS.has(key)) {
      normalized[key] = PRESENT;
    } else if (JSON_ATTRIBUTE_KEYS.has(key) && typeof value === 'string') {
      normalized[key] = normalizeValue(JSON.parse(value));
    } else {
      normalized[key] = normalizeValue(value);
    }
  }
  return normalized;
}

function statusName(code: SpanStatusCode): SpanDigest['status'] {
  switch (code) {
    case SpanStatusCode.OK:
      return 'OK';
    case SpanStatusCode.ERROR:
      return 'ERROR';
    default:
      return 'UNSET';
  }
}

/** Builds the digest of one log record. */
export function logDigest(log: ReadableLogRecord): LogDigest {
  return {
    event_name: log.eventName ?? '',
    body: log.body === undefined ? null : normalizeValue(log.body),
    attributes: normalizeLogAttributes(log.attributes),
  };
}

/** Parameters for {@link buildSpanDigest}. */
export interface BuildSpanDigestParams {
  spans: readonly ReadableSpan[];
  logs?: readonly ReadableLogRecord[];
  /** The processor that saw the spans start. */
  startOrder: StartOrderSpanProcessor;
}

/**
 * Builds the span tree of one run, attaching each log record to the span it
 * was emitted under, in emission order.
 *
 * @throws Error when the spans have no root or more than one.
 */
export function buildSpanDigest({
  spans,
  logs = [],
  startOrder,
}: BuildSpanDigestParams): SpanDigest {
  const digestById = new Map<string, SpanDigest>();
  for (const span of spans) {
    digestById.set(span.spanContext().spanId, {
      name: span.name,
      attributes: normalizeSpanAttributes(span.attributes),
      status: statusName(span.status.code),
      children: [],
      logs: [],
    });
  }

  for (const log of logs) {
    const spanId = log.spanContext?.spanId;
    if (!spanId) {
      continue;
    }
    digestById.get(spanId)?.logs.push(logDigest(log));
  }

  const ordered = [...spans].sort(
    (a, b) =>
      startOrder.positionOf(a.spanContext().spanId) -
      startOrder.positionOf(b.spanContext().spanId),
  );
  let root: SpanDigest | undefined;
  for (const span of ordered) {
    const digest = digestById.get(span.spanContext().spanId);
    if (!digest) {
      continue;
    }
    const parent = digestById.get(span.parentSpanContext?.spanId ?? '');
    if (parent) {
      parent.children.push(digest);
    } else if (root) {
      throw new Error('Multiple root spans found.');
    } else {
      root = digest;
    }
  }
  if (!root) {
    throw new Error('No root span found in the provided spans.');
  }
  return root;
}
