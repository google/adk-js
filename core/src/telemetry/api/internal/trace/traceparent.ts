/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type SpanContext, trace} from '@opentelemetry/api';

const VERSION_REGEX = /^[0-9a-f]{2}$/i;
const TRACE_ID_REGEX = /^[0-9a-f]{32}$/i;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/i;
const TRACE_FLAGS_REGEX = /^[0-9a-f]{2}$/i;
const ALL_ZERO_TRACE_ID = '00000000000000000000000000000000';
const ALL_ZERO_SPAN_ID = '0000000000000000';
const FORBIDDEN_VERSION = 'ff';
const VERSION_00 = '00';
const VERSION_00_LENGTH = 55;

/**
 * Parses and validates a W3C traceparent header string into a remote {@link SpanContext}.
 *
 * Enforces W3C TraceContext rules:
 * - Format is `version-trace_id-parent_id-trace_flags`.
 * - Version must be 2 hex digits and cannot be `ff`.
 * - Version `00` strings must have exactly 4 fields and total length 55 characters.
 * - Trace ID must be 32 hex digits and cannot be all zeros.
 * - Parent ID (span ID) must be 16 hex digits and cannot be all zeros.
 * - Trace flags must be 2 hex digits.
 * - Validated using {@link trace.isSpanContextValid}.
 *
 * @param header The raw W3C traceparent header string.
 * @returns The parsed remote `SpanContext`, or `undefined` if invalid or malformed.
 */
export function parseTraceparent(header: string): SpanContext | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parts = trimmed.split('-');
  if (parts.length < 4) {
    return undefined;
  }

  const [version, traceId, parentId, traceFlags] = parts;

  if (!VERSION_REGEX.test(version)) {
    return undefined;
  }
  const lowerVersion = version.toLowerCase();
  if (lowerVersion === FORBIDDEN_VERSION) {
    return undefined;
  }

  if (lowerVersion === VERSION_00) {
    if (parts.length !== 4 || trimmed.length !== VERSION_00_LENGTH) {
      return undefined;
    }
  }

  if (!TRACE_ID_REGEX.test(traceId) || traceId === ALL_ZERO_TRACE_ID) {
    return undefined;
  }

  if (!SPAN_ID_REGEX.test(parentId) || parentId === ALL_ZERO_SPAN_ID) {
    return undefined;
  }

  if (!TRACE_FLAGS_REGEX.test(traceFlags)) {
    return undefined;
  }
  const flags = parseInt(traceFlags, 16);
  if (Number.isNaN(flags)) {
    return undefined;
  }

  const spanContext: SpanContext = {
    traceId: traceId.toLowerCase(),
    spanId: parentId.toLowerCase(),
    traceFlags: flags,
    isRemote: true,
  };

  if (!trace.isSpanContextValid(spanContext)) {
    return undefined;
  }

  return spanContext;
}
