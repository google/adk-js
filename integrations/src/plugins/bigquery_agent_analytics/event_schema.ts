/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A column of the events table, in the shape BigQuery table schemas use.
 */
export interface EventSchemaField {
  readonly name: string;
  readonly type:
    'TIMESTAMP' | 'STRING' | 'JSON' | 'RECORD' | 'INTEGER' | 'BOOLEAN';
  readonly mode: 'REQUIRED' | 'NULLABLE' | 'REPEATED';
  readonly description: string;
  readonly fields?: readonly EventSchemaField[];
}

/** Version of the table schema, stored as a table label. */
export const SCHEMA_VERSION = '2';

/** Label key that holds {@link SCHEMA_VERSION} on the events table. */
export const SCHEMA_VERSION_LABEL_KEY = 'adk_schema_version';

/** Version of the `attributes.adk` envelope written on every row. */
export const ADK_ENVELOPE_SCHEMA_VERSION = '1';

function freezeFields(
  fields: readonly EventSchemaField[],
): readonly EventSchemaField[] {
  for (const column of fields) {
    if (column.fields) {
      freezeFields(column.fields);
    }
    Object.freeze(column);
  }
  return Object.freeze(fields);
}

/**
 * The columns of the events table.
 *
 * Every row the plugin writes has exactly these columns, so queries and
 * dashboards written for one ADK language work for the others.
 */
export const EVENTS_SCHEMA: readonly EventSchemaField[] = freezeFields([
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
        description: 'The ObjectRef of the content part if stored externally.',
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
]);

/** One `content_parts` entry of an events-table row. */
export interface ContentPartRow {
  part_index: number;
  mime_type: string | null;
  uri: string | null;
  text: string | null;
  part_attributes: string;
  storage_mode: 'INLINE' | 'EXTERNAL_URI';
  object_ref: null;
}

/**
 * One row of the events table, keyed by column name.
 *
 * The JSON columns hold already-serialized JSON text.
 */
export interface EventRow {
  timestamp: Date;
  event_id: string;
  event_type: string;
  agent: string | null;
  session_id: string;
  invocation_id: string;
  user_id: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  content: string | null;
  content_parts: ContentPartRow[];
  attributes: string;
  latency_ms: string | null;
  status: 'OK' | 'ERROR';
  error_message: string | null;
  is_truncated: boolean;
}
