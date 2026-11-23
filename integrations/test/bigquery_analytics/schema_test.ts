/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  getEventsSchema,
  parseCustomMetadataAllowlist,
  projectSchema,
  schemaFieldsMatch,
  validatePayloadColumnDenylist,
} from '../../src/bigquery_analytics/schema.js';
import {golden} from './golden.js';

describe('getEventsSchema', () => {
  it('matches the schema adk-python creates, descriptions included', () => {
    expect(getEventsSchema()).toEqual(golden.schema);
  });

  it('keeps the Python column order, with content_parts as a REPEATED RECORD', () => {
    const schema = getEventsSchema();
    expect(schema.map((field) => field.name)).toEqual([
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
    expect(
      schema.find((field) => field.name === 'content_parts'),
    ).toMatchObject({type: 'RECORD', mode: 'REPEATED'});
  });
});

describe('validatePayloadColumnDenylist', () => {
  it('accepts null and the projectable payload columns', () => {
    expect(validatePayloadColumnDenylist(null).size).toBe(0);
    expect([
      ...validatePayloadColumnDenylist(['content', 'latency_ms']),
    ]).toEqual(['content', 'latency_ms']);
  });

  it.each([
    'timestamp',
    'session_id',
    'span_id',
    'is_truncated',
    'unknown_column',
  ])('rejects %s', (column) => {
    expect(() => validatePayloadColumnDenylist(['content', column])).toThrow(
      `payload_column_denylist may only contain projectable payload columns ['attributes', 'content', 'content_parts', 'latency_ms']; got ['${column}'].`,
    );
  });
});

describe('projectSchema', () => {
  it('returns the schema itself when nothing is denied', () => {
    const schema = getEventsSchema();
    expect(projectSchema({schema, denied: new Set()})).toBe(schema);
  });

  it('drops denied columns only', () => {
    const projected = projectSchema({
      schema: getEventsSchema(),
      denied: new Set(['content_parts', 'attributes']),
    });
    expect(projected.map((field) => field.name)).not.toContain('content_parts');
    expect(projected.map((field) => field.name)).not.toContain('attributes');
    expect(projected).toHaveLength(15);
  });
});

describe('parseCustomMetadataAllowlist', () => {
  it('treats only a trailing * as a prefix pattern', () => {
    const {exact, prefixes} = parseCustomMetadataAllowlist([
      'citation_metadata',
      'a2a:*',
      'x*',
      'y',
    ]);
    expect([...exact]).toEqual(['citation_metadata', 'y']);
    expect(prefixes).toEqual(['a2a:', 'x']);
  });

  it('accepts null', () => {
    const {exact, prefixes} = parseCustomMetadataAllowlist(null);
    expect(exact.size).toBe(0);
    expect(prefixes).toEqual([]);
  });
});

describe('schemaFieldsMatch', () => {
  it('detects a new nested sub-field and merges it into a copy of the existing RECORD', () => {
    const policyTags = {
      names: ['projects/p/locations/us/taxonomies/t/policyTags/pt'],
    };
    const {newFields, updatedRecords} = schemaFieldsMatch({
      existing: [
        {name: 'timestamp', type: 'TIMESTAMP'},
        {
          name: 'metadata',
          type: 'RECORD',
          policyTags,
          fields: [{name: 'key', type: 'STRING'}],
        },
      ],
      desired: [
        {name: 'timestamp', type: 'TIMESTAMP'},
        {
          name: 'metadata',
          type: 'RECORD',
          fields: [
            {name: 'key', type: 'STRING'},
            {name: 'value', type: 'STRING'},
          ],
        },
      ],
    });
    expect(newFields).toEqual([]);
    expect(updatedRecords).toEqual([
      {
        name: 'metadata',
        type: 'RECORD',
        policyTags,
        fields: [
          {name: 'key', type: 'STRING'},
          {name: 'value', type: 'STRING'},
        ],
      },
    ]);
  });

  it('rejects a nested mode change, naming the dotted path', () => {
    expect(() =>
      schemaFieldsMatch({
        existing: [
          {
            name: 'metadata',
            type: 'RECORD',
            fields: [{name: 'key', type: 'STRING', mode: 'NULLABLE'}],
          },
        ],
        desired: [
          {
            name: 'metadata',
            type: 'RECORD',
            fields: [{name: 'key', type: 'STRING', mode: 'REQUIRED'}],
          },
        ],
      }),
    ).toThrow(
      "Incompatible BigQuery schema field 'metadata.key': existing=STRING/NULLABLE, desired=STRING/REQUIRED.",
    );
  });

  it.each([
    ['STRING', 'REQUIRED'],
    ['TIMESTAMP', 'NULLABLE'],
  ])('rejects an existing timestamp of %s/%s', (type, mode) => {
    expect(() =>
      schemaFieldsMatch({
        existing: [{name: 'timestamp', type, mode}],
        desired: getEventsSchema(),
      }),
    ).toThrow(/'timestamp'/);
  });

  it('treats a missing mode as NULLABLE and compares case-insensitively', () => {
    expect(
      schemaFieldsMatch({
        existing: [{name: 'a', type: 'string'}],
        desired: [{name: 'a', type: 'STRING', mode: 'NULLABLE'}],
      }),
    ).toEqual({newFields: [], updatedRecords: []});
  });
});
