/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic telemetry digest builder for functional golden tests.
 *
 * Turns in-memory OpenTelemetry spans, log records, and metrics into a
 * normalized JSON structure (`root_span` tree with nested `logs`, plus
 * `metric_points` grouped by metric name).
 *
 * Deviation for `adk-js`:
 * Legacy `gcp.vertex.agent.*` request/response span attributes
 * (`gcp.vertex.agent.llm_request`, `gcp.vertex.agent.llm_response`,
 * `gcp.vertex.agent.tool_call_args`, `gcp.vertex.agent.tool_response`) are
 * included in `JSON_ATTRIBUTE_KEYS` alongside `gen_ai.*` structured
 * attributes so serialized JSON strings are parsed into normalized objects
 * and nested generated `id` fields collapse to `"PRESENT"`.
 */

import {HrTime, SpanStatusCode} from '@opentelemetry/api';
import {ReadableLogRecord} from '@opentelemetry/sdk-logs';
import {DataPointType, ResourceMetrics} from '@opentelemetry/sdk-metrics';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';

/**
 * Sentinel for a value that cannot be pinned, such as a generated identifier
 * or a wall-clock duration.
 */
export const PRESENT = 'PRESENT';

/**
 * Span and log attribute keys whose values are generated per run and collapse
 * to {@link PRESENT}.
 */
export const NON_DETERMINISTIC_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
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

/**
 * Object property keys inside structured payloads that carry generated
 * identifiers and collapse to {@link PRESENT}.
 */
export const NON_DETERMINISTIC_PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  'id',
]);

/**
 * Span attribute keys whose string values hold serialized JSON payloads.
 *
 * Includes both `gen_ai.*` structured attributes and `gcp.vertex.agent.*`
 * request/response payload attributes so serialized JSON strings are parsed
 * into normalized objects and any nested `id` fields collapse to
 * {@link PRESENT}.
 */
export const JSON_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gcp.vertex.agent.llm_request',
  'gcp.vertex.agent.llm_response',
  'gcp.vertex.agent.tool_call_args',
  'gcp.vertex.agent.tool_response',
]);

/**
 * A deterministic digest of a {@link ReadableLogRecord}.
 */
export interface LogDigest {
  event_name: string;
  body: unknown;
  attributes: Record<string, unknown>;
}

/**
 * A deterministic digest of a span in the in-memory span tree, including
 * child spans and log records emitted while the span was active.
 */
export interface SpanDigest {
  name: string;
  attributes: Record<string, unknown>;
  status: string;
  children: SpanDigest[];
  logs: LogDigest[];
}

/**
 * A single recorded metric data point.
 */
export interface MetricPoint {
  attributes: Record<string, unknown>;
  value: unknown;
}

/**
 * The full telemetry surface produced by one scenario run.
 */
export interface TelemetryDigest {
  root_span: SpanDigest;
  metric_points: Record<string, MetricPoint[]>;
}

function hrTimeToNanos(hrTime: HrTime): bigint {
  return BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1]);
}

function formatStatusCode(code: SpanStatusCode): string {
  switch (code) {
    case SpanStatusCode.OK:
      return 'OK';
    case SpanStatusCode.ERROR:
      return 'ERROR';
    case SpanStatusCode.UNSET:
    default:
      return 'UNSET';
  }
}

/**
 * Normalizes a structured payload value for deterministic comparison:
 * - Arrays are normalized element-by-element.
 * - Plain objects have `null`/`undefined` entries dropped, keys sorted
 *   lexicographically, and fields in {@link NON_DETERMINISTIC_PAYLOAD_FIELDS}
 *   collapsed to {@link PRESENT}.
 */
export function normalizePayload(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePayload(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === null || item === undefined) {
        continue;
      }
      normalized[key] = NON_DETERMINISTIC_PAYLOAD_FIELDS.has(key)
        ? PRESENT
        : normalizePayload(item);
    }
    return normalized;
  }
  return value;
}

/**
 * Normalizes span or log attributes:
 * - Keys in {@link NON_DETERMINISTIC_ATTRIBUTE_KEYS} collapse to {@link PRESENT}.
 * - Keys in {@link JSON_ATTRIBUTE_KEYS} with valid JSON string values are
 *   parsed and passed through {@link normalizePayload}.
 * - All other values pass through {@link normalizePayload}.
 */
export function normalizeAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!attributes) {
    return {};
  }
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = attributes[key];
    if (value === undefined) {
      continue;
    }
    if (NON_DETERMINISTIC_ATTRIBUTE_KEYS.has(key)) {
      normalized[key] = PRESENT;
    } else if (JSON_ATTRIBUTE_KEYS.has(key) && typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        normalized[key] = normalizePayload(parsed);
      } catch {
        normalized[key] = normalizePayload(value);
      }
    } else {
      normalized[key] = normalizePayload(value);
    }
  }
  return normalized;
}

function buildLogDigest(log: ReadableLogRecord): LogDigest {
  return {
    event_name: log.eventName ?? '',
    body: normalizePayload(log.body ?? null),
    attributes: normalizeAttributes(
      log.attributes as Record<string, unknown> | undefined,
    ),
  };
}

function buildSpanTree(
  spans: readonly ReadableSpan[],
  logs: readonly ReadableLogRecord[],
): SpanDigest {
  const digestById = new Map<string, SpanDigest>();
  for (const span of spans) {
    const spanId = span.spanContext().spanId;
    digestById.set(spanId, {
      name: span.name,
      attributes: normalizeAttributes(
        span.attributes as Record<string, unknown>,
      ),
      status: formatStatusCode(span.status.code),
      children: [],
      logs: [],
    });
  }

  const orderedLogs = [...logs].sort((a, b) => {
    const diff =
      hrTimeToNanos(a.hrTimeObserved) - hrTimeToNanos(b.hrTimeObserved);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  });

  for (const log of orderedLogs) {
    const spanId = log.spanContext?.spanId;
    const owner = spanId ? digestById.get(spanId) : undefined;
    if (!owner) {
      throw new Error(
        `Log record "${log.eventName ?? ''}" was emitted outside any collected span.`,
      );
    }
    owner.logs.push(buildLogDigest(log));
  }

  const orderedSpans = [...spans].sort((a, b) => {
    const diff = hrTimeToNanos(a.startTime) - hrTimeToNanos(b.startTime);
    if (diff !== 0n) {
      return diff < 0n ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  let root: SpanDigest | undefined;
  for (const span of orderedSpans) {
    const spanId = span.spanContext().spanId;
    const digest = digestById.get(spanId);
    if (!digest) {
      continue;
    }
    const parentSpanId = span.parentSpanContext?.spanId;
    const parentDigest = parentSpanId
      ? digestById.get(parentSpanId)
      : undefined;
    if (parentDigest) {
      parentDigest.children.push(digest);
    } else if (root !== undefined) {
      throw new Error('Multiple root spans found.');
    } else {
      root = digest;
    }
  }

  if (root === undefined) {
    throw new Error('No root span found in the provided spans.');
  }

  return root;
}

function canonicalJsonKey(value: unknown): string {
  return JSON.stringify(normalizePayload(value));
}

function groupMetricPoints(
  resourceMetricsList: readonly ResourceMetrics[],
): Record<string, MetricPoint[]> {
  const grouped = new Map<string, Map<string, MetricPoint>>();

  for (const resourceMetrics of resourceMetricsList) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        const name = metric.descriptor.name;
        for (const dp of metric.dataPoints) {
          let value: unknown;
          if (name.endsWith('.duration')) {
            value = PRESENT;
          } else if (metric.dataPointType === DataPointType.HISTOGRAM) {
            value =
              typeof dp.value === 'object' &&
              dp.value !== null &&
              'sum' in dp.value
                ? (dp.value.sum ?? PRESENT)
                : PRESENT;
          } else if (
            metric.dataPointType === DataPointType.SUM ||
            metric.dataPointType === DataPointType.GAUGE
          ) {
            value = dp.value;
          } else {
            value = PRESENT;
          }

          const attributes = normalizeAttributes(
            dp.attributes as Record<string, unknown>,
          );
          const point: MetricPoint = {attributes, value};
          const dedupKey = `${canonicalJsonKey(attributes)}:${canonicalJsonKey(value)}`;
          let pointsForMetric = grouped.get(name);
          if (!pointsForMetric) {
            pointsForMetric = new Map<string, MetricPoint>();
            grouped.set(name, pointsForMetric);
          }
          pointsForMetric.set(dedupKey, point);
        }
      }
    }
  }

  const sortedNames = [...grouped.keys()].sort();
  const result: Record<string, MetricPoint[]> = {};
  for (const name of sortedNames) {
    const pointsMap = grouped.get(name);
    if (!pointsMap) {
      continue;
    }
    const points = [...pointsMap.values()].sort((a, b) =>
      canonicalJsonKey(a.attributes).localeCompare(
        canonicalJsonKey(b.attributes),
      ),
    );
    result[name] = points;
  }
  return result;
}

/**
 * Builds a deterministic {@link TelemetryDigest} from in-memory OpenTelemetry
 * spans, log records, and collected resource metrics.
 */
export function buildTelemetryDigest(
  spans: readonly ReadableSpan[],
  logs: readonly ReadableLogRecord[] = [],
  resourceMetrics: readonly ResourceMetrics[] = [],
): TelemetryDigest {
  return {
    root_span: buildSpanTree(spans, logs),
    metric_points: groupMetricPoints(resourceMetrics),
  };
}
