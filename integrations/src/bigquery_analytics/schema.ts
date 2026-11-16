/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type TableField} from '@google-cloud/bigquery';

export const SCHEMA_VERSION = '2';
export const SCHEMA_VERSION_LABEL_KEY = 'adk_schema_version';

/**
 * Version of the ADK 2.0 attribute contract stamped as
 * `attributes.adk.schema_version`. Independent of {@link SCHEMA_VERSION}, which
 * versions the table's columns.
 */
export const ADK_ENVELOPE_SCHEMA_VERSION = '1';

/** Returns the BigQuery schema for the events table. */
export function getEventsSchema(): Array<TableField> {
  return [
    {
      name: 'timestamp',
      type: 'TIMESTAMP',
      mode: 'REQUIRED',
      description:
        'The UTC timestamp when the event occurred. Used for ordering events within a session.',
    },
    {
      name: 'event_id',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        'A unique identifier assigned before enqueue. Storage Write API retries preserve this value so duplicate rows can be identified reliably.',
    },
    {
      name: 'event_type',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        "The category of the event (e.g., 'LLM_REQUEST', 'TOOL_CALL', 'AGENT_RESPONSE'). Helps in filtering specific types of interactions.",
    },
    {
      name: 'agent',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        'The name of the agent that generated this event. Useful for multi-agent systems.',
    },
    {
      name: 'session_id',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        'A unique identifier for the entire conversation session. Used to group all events belonging to a single user interaction.',
    },
    {
      name: 'invocation_id',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        'A unique identifier for a single turn or execution within a session. Groups related events like LLM request and response.',
    },
    {
      name: 'user_id',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        'The identifier of the end-user participating in the session, if available.',
    },
    {
      name: 'trace_id',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        'OpenTelemetry trace ID for distributed tracing across services.',
    },
    {
      name: 'span_id',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        "BQAA-internal execution-tree span id for this operation. This is the plugin's own correlation id used with parent_span_id to reconstruct the agent/LLM/tool tree -- NOT the OpenTelemetry span id, except on the root/invocation row where it may reuse the ambient OTel span id. For span-level Cloud Trace correlation use attributes.otel.span_id (best-effort).",
    },
    {
      name: 'parent_span_id',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        'BQAA-internal parent execution-tree span id, used to reconstruct the operation hierarchy. Points at another BQAA row, not an OpenTelemetry parent span.',
    },
    {
      name: 'content',
      type: 'JSON',
      mode: 'NULLABLE',
      description:
        'The primary payload of the event, stored as a JSON string. The structure depends on the event_type (e.g., prompt text for LLM_REQUEST, tool output for TOOL_RESPONSE).',
    },
    {
      name: 'content_parts',
      type: 'RECORD',
      mode: 'REPEATED',
      description:
        'For multi-modal events, contains a list of content parts (text, images, etc.).',
      fields: [
        {
          name: 'mime_type',
          type: 'STRING',
          mode: 'NULLABLE',
          description:
            "The MIME type of the content part (e.g., 'text/plain', 'image/png').",
        },
        {
          name: 'uri',
          type: 'STRING',
          mode: 'NULLABLE',
          description:
            'The URI of the content part if stored externally (e.g., GCS bucket path).',
        },
        {
          name: 'object_ref',
          type: 'RECORD',
          mode: 'NULLABLE',
          description:
            'The ObjectRef of the content part if stored externally.',
          fields: [
            {
              name: 'uri',
              type: 'STRING',
              mode: 'NULLABLE',
              description: 'The URI of the object.',
            },
            {
              name: 'version',
              type: 'STRING',
              mode: 'NULLABLE',
              description: 'The version of the object.',
            },
            {
              name: 'authorizer',
              type: 'STRING',
              mode: 'NULLABLE',
              description: 'The authorizer for the object.',
            },
            {
              name: 'details',
              type: 'JSON',
              mode: 'NULLABLE',
              description: 'Additional details about the object.',
            },
          ],
        },
        {
          name: 'text',
          type: 'STRING',
          mode: 'NULLABLE',
          description: 'The raw text content if the part is text-based.',
        },
        {
          name: 'part_index',
          type: 'INTEGER',
          mode: 'NULLABLE',
          description: 'The zero-based index of this part within the content.',
        },
        {
          name: 'part_attributes',
          type: 'STRING',
          mode: 'NULLABLE',
          description:
            'Additional metadata for this content part as a JSON object (serialized to string).',
        },
        {
          name: 'storage_mode',
          type: 'STRING',
          mode: 'NULLABLE',
          description:
            "Indicates how the content part is stored (e.g., 'INLINE', 'GCS_REFERENCE', 'EXTERNAL_URI').",
        },
      ],
    },
    {
      name: 'attributes',
      type: 'JSON',
      mode: 'NULLABLE',
      description:
        "A JSON object containing arbitrary key-value pairs for additional event metadata. Includes enrichment fields like 'root_agent_name' (turn orchestration), 'model' (request model), 'model_version' (response version), and 'usage_metadata' (detailed token counts). May also carry 'otel' (best-effort ambient Cloud Trace span/trace ids) and 'custom_metadata' (allowlisted event.custom_metadata keys).",
    },
    {
      name: 'latency_ms',
      type: 'JSON',
      mode: 'NULLABLE',
      description:
        "A JSON object containing latency measurements, such as 'total_ms' and 'time_to_first_token_ms'.",
    },
    {
      name: 'status',
      type: 'STRING',
      mode: 'NULLABLE',
      description: "The outcome of the event, typically 'OK' or 'ERROR'.",
    },
    {
      name: 'error_message',
      type: 'STRING',
      mode: 'NULLABLE',
      description:
        "Diagnostic message for errors and model termination details; may be populated on rows whose status is 'OK', such as LLM_RESPONSE rows and rows whose content_formatter failed.",
    },
    {
      name: 'is_truncated',
      type: 'BOOLEAN',
      mode: 'NULLABLE',
      description:
        "Boolean flag indicating if the content or metadata payload was truncated because it exceeded the maximum allowed size. Set when 'content', captured 'custom_metadata', or A2A metadata is truncated; redaction of sensitive keys does not set this flag.",
    },
  ];
}

const PROJECTABLE_PAYLOAD_COLUMNS: ReadonlySet<string> = new Set([
  'content',
  'content_parts',
  'attributes',
  'latency_ms',
]);

/**
 * Formats a string list the way Python prints `sorted(...)`, so messages match
 * adk-python.
 */
export function pythonList(values: Iterable<string>): string {
  const quoted = [...values].sort().map((value) => `'${value}'`);
  return `[${quoted.join(', ')}]`;
}

/**
 * Validates `payloadColumnDenylist` and returns the denied set. Only payload
 * columns may be denied, so a typo or an attempt to drop a join key fails at
 * construction instead of producing broken rows or views.
 */
export function validatePayloadColumnDenylist(
  list: ReadonlyArray<string> | null,
): ReadonlySet<string> {
  const denied = new Set(list ?? []);
  const invalid = [...denied].filter(
    (column) => !PROJECTABLE_PAYLOAD_COLUMNS.has(column),
  );
  if (invalid.length > 0) {
    throw new RangeError(
      `payload_column_denylist may only contain projectable payload columns ${pythonList(PROJECTABLE_PAYLOAD_COLUMNS)}; got ${pythonList(invalid)}. Identity/correlation columns (timestamp, event_type, session_id, invocation_id, trace_id, span_id, parent_span_id, is_truncated, ...) are protected and cannot be projected out.`,
    );
  }
  return denied;
}

/** Returns `schema` with denied columns removed (schema-first projection). */
export function projectSchema({
  schema,
  denied,
}: {
  schema: Array<TableField>;
  denied: ReadonlySet<string>;
}): Array<TableField> {
  if (denied.size === 0) {
    return schema;
  }
  return schema.filter(
    (field) => field.name === undefined || !denied.has(field.name),
  );
}

export interface CustomMetadataAllowlist {
  exact: ReadonlySet<string>;
  prefixes: ReadonlyArray<string>;
}

/**
 * Splits the allowlist into exact keys and explicit prefix patterns. Only an
 * entry ending in `*` is a prefix, so a plain key like `citation_metadata`
 * never matches `citation_metadata_extra`.
 */
export function parseCustomMetadataAllowlist(
  list: ReadonlyArray<string> | null,
): CustomMetadataAllowlist {
  const exact = new Set<string>();
  const prefixes: Array<string> = [];
  for (const entry of list ?? []) {
    if (entry.endsWith('*')) {
      prefixes.push(entry.slice(0, -1));
    } else {
      exact.add(entry);
    }
  }
  return {exact, prefixes};
}

export interface SchemaDiff {
  /** Desired fields absent from the existing schema. */
  newFields: Array<TableField>;
  /**
   * Existing RECORD fields, each copied with its missing sub-fields appended.
   */
  updatedRecords: Array<TableField>;
}

function upper(value: string | undefined, fallback: string): string {
  return (value ?? fallback).toUpperCase();
}

/** Replaces each field that has an updated copy, keeping field order. */
export function mergeUpdated({
  fields,
  updated,
}: {
  fields: ReadonlyArray<TableField>;
  updated: ReadonlyArray<TableField>;
}): Array<TableField> {
  const updatedByName = new Map(updated.map((field) => [field.name, field]));
  return fields.map((field) => updatedByName.get(field.name) ?? field);
}

/**
 * Compares existing and desired fields recursively. An updated RECORD is a copy
 * of the existing field, so attributes such as policy tags survive the upgrade.
 * A type or mode change is not additive and throws.
 */
export function schemaFieldsMatch({
  existing,
  desired,
  path = [],
}: {
  existing: ReadonlyArray<TableField>;
  desired: ReadonlyArray<TableField>;
  path?: ReadonlyArray<string>;
}): SchemaDiff {
  const existingByName = new Map(existing.map((field) => [field.name, field]));
  const newFields: Array<TableField> = [];
  const updatedRecords: Array<TableField> = [];

  for (const desiredField of desired) {
    const existingField = existingByName.get(desiredField.name);
    if (existingField === undefined) {
      newFields.push(desiredField);
      continue;
    }

    const fieldPath = [...path, desiredField.name ?? ''].join('.');
    const existingType = upper(existingField.type, 'STRING');
    const desiredType = upper(desiredField.type, 'STRING');
    const existingMode = upper(existingField.mode, 'NULLABLE');
    const desiredMode = upper(desiredField.mode, 'NULLABLE');
    if (existingType !== desiredType || existingMode !== desiredMode) {
      throw new RangeError(
        `Incompatible BigQuery schema field '${fieldPath}': existing=${existingType}/${existingMode}, desired=${desiredType}/${desiredMode}.`,
      );
    }

    if (
      desiredType !== 'RECORD' ||
      desiredField.fields === undefined ||
      desiredField.fields.length === 0
    ) {
      continue;
    }
    const existingSubFields = existingField.fields ?? [];
    const sub = schemaFieldsMatch({
      existing: existingSubFields,
      desired: desiredField.fields,
      path: [...path, desiredField.name ?? ''],
    });
    if (sub.newFields.length > 0 || sub.updatedRecords.length > 0) {
      updatedRecords.push({
        ...existingField,
        fields: [
          ...mergeUpdated({
            fields: existingSubFields,
            updated: sub.updatedRecords,
          }),
          ...sub.newFields,
        ],
      });
    }
  }

  return {newFields, updatedRecords};
}
