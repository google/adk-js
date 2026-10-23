/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A JSON-native value, the shape every JSON column carries before it is
 * serialized.
 */
export type JsonValue =
  string | number | boolean | null | Array<JsonValue> | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ObjectRef {
  uri: string | null;
  version: string | null;
  authorizer: string | null;
  details: JsonValue;
}

export interface ContentPart {
  mime_type: string | null;
  uri: string | null;
  object_ref: ObjectRef | null;
  text: string | null;
  part_index: number | null;
  part_attributes: string | null;
  storage_mode: string | null;
}

/** One row of the events table, keyed by BigQuery column name. */
export interface EventRow {
  timestamp: Date;
  event_id: string | null;
  event_type: string | null;
  agent: string | null;
  session_id: string | null;
  invocation_id: string | null;
  user_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  content?: JsonValue;
  content_parts?: Array<ContentPart>;
  attributes?: JsonValue;
  latency_ms?: JsonValue;
  status: string | null;
  error_message: string | null;
  is_truncated: boolean | null;
}

export type EventStatus = 'OK' | 'ERROR';

export const DROP_REASONS = [
  'queue_full',
  'arrow_prep_failed',
  'retry_exhausted',
  'non_retryable',
  'unexpected_error',
  'shutdown_timeout',
  'shutdown_cancelled',
  'offset_conflict',
  'permission_denied',
  'not_found',
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

export type DropStats = Record<string, number>;
