/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  ADK_ENVELOPE_SCHEMA_VERSION,
  EVENTS_SCHEMA,
  SCHEMA_VERSION,
  SCHEMA_VERSION_LABEL_KEY,
} from '../../../src/plugins/bigquery_agent_analytics/event_schema.js';

describe('event_schema', () => {
  it('exposes the expected schema versions and constants', () => {
    expect(SCHEMA_VERSION).toBe('2');
    expect(SCHEMA_VERSION_LABEL_KEY).toBe('adk_schema_version');
    expect(ADK_ENVELOPE_SCHEMA_VERSION).toBe('1');
  });

  it('defines exactly the 17 expected columns', () => {
    expect(EVENTS_SCHEMA.length).toBe(17);

    const columnNames = EVENTS_SCHEMA.map((c) => c.name);
    expect(columnNames).toEqual([
      'timestamp',
      'event_id',
      'event_type',
      'agent',
      'session_id',
      'invocation_id',
      'user_id',
      'trace_id',
      'span_id',
      'parent_span_id',
      'content',
      'content_parts',
      'attributes',
      'latency_ms',
      'status',
      'error_message',
      'is_truncated',
    ]);
  });

  it('defines the required timestamp partition column', () => {
    const timestampCol = EVENTS_SCHEMA.find((c) => c.name === 'timestamp');
    expect(timestampCol).toBeDefined();
    expect(timestampCol?.type).toBe('TIMESTAMP');
    expect(timestampCol?.mode).toBe('REQUIRED');
  });

  it('defines repeated content_parts with nested fields matching adk-python', () => {
    const partsCol = EVENTS_SCHEMA.find((c) => c.name === 'content_parts');
    expect(partsCol).toBeDefined();
    expect(partsCol?.type).toBe('RECORD');
    expect(partsCol?.mode).toBe('REPEATED');

    const fieldNames = partsCol?.fields?.map((f) => f.name);
    expect(fieldNames).toEqual([
      'mime_type',
      'uri',
      'object_ref',
      'text',
      'part_index',
      'part_attributes',
      'storage_mode',
    ]);

    const objectRefField = partsCol?.fields?.find(
      (f) => f.name === 'object_ref',
    );
    expect(objectRefField?.type).toBe('RECORD');
    expect(objectRefField?.mode).toBe('NULLABLE');
    expect(objectRefField?.fields?.map((f) => f.name)).toEqual([
      'uri',
      'version',
      'authorizer',
      'details',
    ]);
  });
});
