/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQuery, Table} from '@google-cloud/bigquery';
import type * as bqStorage from '@google-cloud/bigquery-storage';
import {getLogger} from '@google/adk';

import {version} from '../../version.js';
import type {AppendResult} from './batch_processor.js';
import {
  EVENTS_SCHEMA,
  type EventRow,
  type EventSchemaField,
  SCHEMA_VERSION,
  SCHEMA_VERSION_LABEL_KEY,
} from './event_schema.js';

const logger = getLogger();

interface BigQuerySdks {
  readonly BigQuery: typeof BigQuery;
  readonly storage: typeof bqStorage;
}

let sdksPromise: Promise<BigQuerySdks> | null = null;

/**
 * Dynamically loads the optional `@google-cloud/bigquery` and `@google-cloud/bigquery-storage` packages.
 */
export async function loadBigQuerySdks(): Promise<BigQuerySdks> {
  if (sdksPromise !== null) {
    return sdksPromise;
  }
  sdksPromise = (async () => {
    try {
      const bqModule = await import('@google-cloud/bigquery');
      const bqStorageModule = await import('@google-cloud/bigquery-storage');
      return {
        BigQuery: bqModule.BigQuery,
        storage: bqStorageModule,
      };
    } catch (cause: unknown) {
      sdksPromise = null;
      throw new Error(
        "BigQueryAgentAnalyticsPlugin requires the optional '@google-cloud/bigquery' and '@google-cloud/bigquery-storage' packages. " +
          'Install them with: npm install @google-cloud/bigquery @google-cloud/bigquery-storage',
        {cause},
      );
    }
  })();
  return sdksPromise;
}

function extractCode(err: unknown): number | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'number'
  ) {
    return err.code;
  }
  return undefined;
}

/** Raw BigQuery table field representation. */
export interface RawTableField {
  readonly name?: string;
  readonly type?: string;
  readonly mode?: string;
  readonly description?: string;
  readonly fields?: readonly RawTableField[];
  readonly [key: string]: unknown;
}

/** Result of comparing existing vs desired schema fields. */
export interface SchemaMatchResult {
  readonly newFields: EventSchemaField[];
  readonly updatedRecords: RawTableField[];
}

/**
 * Compares existing vs desired schema fields recursively.
 */
export function matchSchemaFields(
  existing: readonly RawTableField[],
  desired: readonly EventSchemaField[],
  path: readonly string[] = [],
): SchemaMatchResult {
  const existingByName = new Map<string, RawTableField>();
  for (const field of existing) {
    if (field.name) {
      existingByName.set(field.name, field);
    }
  }

  const newFields: EventSchemaField[] = [];
  const updatedRecords: RawTableField[] = [];

  for (const desiredField of desired) {
    const existingField = existingByName.get(desiredField.name);
    if (!existingField) {
      newFields.push(desiredField);
      continue;
    }

    const fieldPath = [...path, desiredField.name].join('.');
    const existingType = (existingField.type ?? 'STRING').toUpperCase();
    const desiredType = desiredField.type.toUpperCase();
    const existingMode = (existingField.mode ?? 'NULLABLE').toUpperCase();
    const desiredMode = desiredField.mode.toUpperCase();

    const normalizedExistingType =
      existingType === 'INT64'
        ? 'INTEGER'
        : existingType === 'BOOL'
          ? 'BOOLEAN'
          : existingType === 'STRUCT'
            ? 'RECORD'
            : existingType;
    const normalizedDesiredType =
      desiredType === 'INT64'
        ? 'INTEGER'
        : desiredType === 'BOOL'
          ? 'BOOLEAN'
          : desiredType === 'STRUCT'
            ? 'RECORD'
            : desiredType;

    if (
      normalizedExistingType !== normalizedDesiredType ||
      existingMode !== desiredMode
    ) {
      throw new Error(
        `Incompatible BigQuery schema field '${fieldPath}': existing=${existingType}/${existingMode}, desired=${desiredType}/${desiredMode}.`,
      );
    }

    if (normalizedDesiredType === 'RECORD' && desiredField.fields) {
      const subMatch = matchSchemaFields(
        existingField.fields ?? [],
        desiredField.fields,
        [...path, desiredField.name],
      );
      if (subMatch.newFields.length > 0 || subMatch.updatedRecords.length > 0) {
        const updatedByName = new Map<string, RawTableField>();
        for (const u of subMatch.updatedRecords) {
          if (u.name) {
            updatedByName.set(u.name, u);
          }
        }
        const mergedSub: RawTableField[] = (existingField.fields ?? []).map(
          (f) => (f.name ? updatedByName.get(f.name) : undefined) ?? f,
        );
        for (const nf of subMatch.newFields) {
          mergedSub.push(JSON.parse(JSON.stringify(nf)) as RawTableField);
        }
        updatedRecords.push({
          ...existingField,
          fields: mergedSub,
        });
      }
    }
  }

  return {newFields, updatedRecords};
}

interface TableMetadataLike {
  schema?: {
    fields?: RawTableField[];
  };
  labels?: Record<string, string>;
}

/**
 * Adds missing columns to an existing table (additive only).
 */
export async function maybeUpgradeSchema(
  table: Table,
  desiredSchema: readonly EventSchemaField[] = EVENTS_SCHEMA,
): Promise<void> {
  const existingTable = table as unknown as {
    metadata?: TableMetadataLike;
    getMetadata?: () => Promise<[TableMetadataLike]>;
    setMetadata?: (metadata: TableMetadataLike) => Promise<unknown>;
  };

  let metadata: TableMetadataLike | undefined = existingTable.metadata;
  if (!metadata?.schema && typeof existingTable.getMetadata === 'function') {
    const metadataRes = await existingTable.getMetadata();
    metadata = metadataRes[0];
  }
  if (!metadata) {
    return;
  }

  const existingFields = metadata.schema?.fields ?? [];
  const schemaDiff = matchSchemaFields(existingFields, desiredSchema);
  const newFields = schemaDiff.newFields;
  const updatedRecords = schemaDiff.updatedRecords;
  const storedVersion = metadata.labels?.[SCHEMA_VERSION_LABEL_KEY];

  if (
    newFields.length === 0 &&
    updatedRecords.length === 0 &&
    storedVersion === SCHEMA_VERSION
  ) {
    return;
  }

  let nextFields = existingFields;
  if (newFields.length > 0 || updatedRecords.length > 0) {
    const updatedByName = new Map<string, RawTableField>();
    for (const u of updatedRecords) {
      if (u.name) {
        updatedByName.set(u.name, u);
      }
    }
    nextFields = existingFields.map(
      (f) => (f.name ? updatedByName.get(f.name) : undefined) ?? f,
    );
    for (const nf of newFields) {
      nextFields.push(JSON.parse(JSON.stringify(nf)) as RawTableField);
    }
  }

  const nextLabels: Record<string, string> = {
    ...(metadata.labels ?? {}),
    [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION,
  };

  try {
    if (typeof existingTable.setMetadata === 'function') {
      await existingTable.setMetadata({
        schema: {fields: nextFields},
        labels: nextLabels,
      });
    }
  } catch (err: unknown) {
    logger.error(
      `Schema auto-upgrade failed: ${
        err instanceof Error ? err.message : 'Unknown error'
      }`,
    );
    if (newFields.length > 0 || updatedRecords.length > 0) {
      throw err;
    }
  }
}

const VIEW_COMMON_COLUMNS = [
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
  'status',
  'error_message',
  'is_truncated',
] as const;

const NODE_IDENTITY_VIEW_COLUMNS = [
  "JSON_VALUE(attributes, '$.adk.node.path') AS node_path",
  "JSON_VALUE(attributes, '$.adk.node.run_id') AS node_run_id",
  "JSON_VALUE(attributes, '$.adk.node.parent_run_id') AS node_parent_run_id",
] as const;

/** Per-event-type column extractions for analytics views. */
export const EVENT_VIEW_DEFS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    USER_MESSAGE_RECEIVED: [],
    LLM_REQUEST: [
      "JSON_VALUE(attributes, '$.model') AS model",
      'content AS request_content',
      "JSON_QUERY(attributes, '$.llm_config') AS llm_config",
      "JSON_QUERY(attributes, '$.tools') AS tools",
    ],
    LLM_RESPONSE: [
      "JSON_QUERY(content, '$.response') AS response",
      "CAST(JSON_VALUE(content, '$.usage.prompt') AS INT64) AS usage_prompt_tokens",
      "CAST(JSON_VALUE(content, '$.usage.completion') AS INT64) AS usage_completion_tokens",
      "CAST(JSON_VALUE(content, '$.usage.total') AS INT64) AS usage_total_tokens",
      "CAST(JSON_VALUE(attributes, '$.usage_metadata.cached_content_token_count') AS INT64) AS usage_cached_tokens",
      "CAST(JSON_VALUE(attributes, '$.usage_metadata.thoughts_token_count') AS INT64) AS usage_thinking_tokens",
      "CAST(JSON_VALUE(attributes, '$.usage_metadata.tool_use_prompt_token_count') AS INT64) AS usage_tool_use_tokens",
      "SAFE_DIVIDE(CAST(JSON_VALUE(attributes, '$.usage_metadata.cached_content_token_count') AS INT64),CAST(JSON_VALUE(content, '$.usage.prompt') AS INT64)) AS context_cache_hit_rate",
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
      "CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS INT64) AS ttft_ms",
      "JSON_VALUE(attributes, '$.model_version') AS model_version",
      "JSON_QUERY(attributes, '$.usage_metadata') AS usage_metadata",
      "JSON_QUERY(attributes, '$.cache_metadata') AS cache_metadata",
      "JSON_VALUE(attributes, '$.cache_type') AS cache_type",
      "JSON_VALUE(attributes, '$.finish_reason') AS finish_reason",
    ],
    LLM_ERROR: [
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
    ],
    TOOL_STARTING: [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
      "JSON_VALUE(content, '$.tool_origin') AS tool_origin",
    ],
    TOOL_COMPLETED: [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.result') AS tool_result",
      "JSON_VALUE(content, '$.tool_origin') AS tool_origin",
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
      "JSON_VALUE(attributes, '$.adk.pause_kind') AS pause_kind",
      "JSON_VALUE(attributes, '$.adk.function_call_id') AS function_call_id",
    ],
    TOOL_ERROR: [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
      "JSON_VALUE(content, '$.tool_origin') AS tool_origin",
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
    ],
    AGENT_STARTING: [
      "COALESCE(JSON_VALUE(content, '$.text_summary'), IF(REGEXP_CONTAINS(JSON_VALUE(content, '$'), r'^(?:<(?:function|bound method) |<.+ at 0x[0-9a-fA-F]+>|functools\\\\.partial\\\\()'), NULL, JSON_VALUE(content, '$'))) AS agent_instruction",
      "JSON_VALUE(attributes, '$.instruction_source') AS instruction_source",
      "JSON_VALUE(attributes, '$.static_instruction') AS static_instruction",
      "JSON_VALUE(attributes, '$.agent_description') AS agent_description",
      "JSON_VALUE(attributes, '$.model') AS model",
      "JSON_QUERY(attributes, '$.sub_agents') AS sub_agents",
    ],
    AGENT_COMPLETED: [
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
    ],
    AGENT_ERROR: [
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
      "JSON_VALUE(content, '$.error_traceback') AS error_traceback",
    ],
    INVOCATION_STARTING: [],
    INVOCATION_COMPLETED: [],
    INVOCATION_ERROR: [
      "JSON_VALUE(content, '$.error_traceback') AS error_traceback",
    ],
    STATE_DELTA: ["JSON_QUERY(attributes, '$.state_delta') AS state_delta"],
    HITL_CREDENTIAL_REQUEST: [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
    ],
    HITL_CONFIRMATION_REQUEST: [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
    ],
    HITL_INPUT_REQUEST: [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
    ],
    A2A_INTERACTION: [
      'content AS response_content',
      'JSON_VALUE(attributes, \'$.a2a_metadata."a2a:task_id"\') AS a2a_task_id',
      'JSON_VALUE(attributes, \'$.a2a_metadata."a2a:context_id"\') AS a2a_context_id',
      'JSON_QUERY(attributes, \'$.a2a_metadata."a2a:request"\') AS a2a_request',
      'JSON_QUERY(attributes, \'$.a2a_metadata."a2a:response"\') AS a2a_response',
    ],
    AGENT_RESPONSE: [
      "JSON_VALUE(content, '$.response') AS response_text",
      "JSON_VALUE(attributes, '$.source_event_id') AS source_event_id",
      "JSON_VALUE(attributes, '$.source_event_author') AS source_event_author",
      "JSON_VALUE(attributes, '$.source_event_branch') AS source_event_branch",
    ],
    AGENT_TRANSFER: [
      "JSON_VALUE(content, '$.from_agent') AS from_agent",
      "JSON_VALUE(content, '$.to_agent') AS to_agent",
      "JSON_VALUE(attributes, '$.adk.source_event_id') AS source_event_id",
    ],
    EVENT_COMPACTION: [
      "CAST(JSON_VALUE(content, '$.start_timestamp') AS FLOAT64) AS start_seconds",
      "CAST(JSON_VALUE(content, '$.end_timestamp') AS FLOAT64) AS end_seconds",
      "TIMESTAMP_MICROS(CAST(CAST(JSON_VALUE(content, '$.start_timestamp') AS FLOAT64) * 1000000 AS INT64)) AS window_start",
      "TIMESTAMP_MICROS(CAST(CAST(JSON_VALUE(content, '$.end_timestamp') AS FLOAT64) * 1000000 AS INT64)) AS window_end",
      "JSON_QUERY(content, '$.compacted_content') AS compacted_content",
    ],
    AGENT_STATE_CHECKPOINT: [
      "JSON_QUERY(content, '$.agent_state') AS agent_state",
      "JSON_TYPE(JSON_QUERY(content, '$.agent_state')) AS agent_state_type",
      "SAFE_CAST(JSON_VALUE(content, '$.end_of_agent') AS BOOL) AS end_of_agent",
      "JSON_VALUE(attributes, '$.adk.source_event_id') AS source_event_id",
    ],
    TOOL_PAUSED: [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
      "JSON_VALUE(attributes, '$.adk.pause_kind') AS pause_kind",
      "JSON_VALUE(attributes, '$.adk.function_call_id') AS function_call_id",
    ],
    NODE_OUTPUT: [...NODE_IDENTITY_VIEW_COLUMNS, 'content AS output'],
    NODE_ERROR: [
      ...NODE_IDENTITY_VIEW_COLUMNS,
      "JSON_VALUE(content, '$.error_code') AS error_code",
    ],
    WORKFLOW_NODE_FIRST_OBSERVED: [
      "JSON_VALUE(attributes, '$.adk.app_name') AS app_name",
      "JSON_VALUE(attributes, '$.adk.workflow_segment_id') AS workflow_segment_id",
      ...NODE_IDENTITY_VIEW_COLUMNS,
      "JSON_VALUE(attributes, '$.adk.source_event_id') AS source_event_id",
      "SAFE.TIMESTAMP_MICROS(SAFE_CAST(SAFE_CAST(JSON_VALUE(attributes, '$.adk.source_event_timestamp') AS FLOAT64) * 1000000 AS INT64)) AS source_event_timestamp",
      "JSON_VALUE(attributes, '$.adk.boundary_basis') AS boundary_basis",
    ],
    WORKFLOW_NODE_OBSERVATION_SUMMARY: [
      "JSON_VALUE(attributes, '$.adk.app_name') AS app_name",
      "JSON_VALUE(attributes, '$.adk.workflow_segment_id') AS workflow_segment_id",
      ...NODE_IDENTITY_VIEW_COLUMNS,
      "JSON_VALUE(attributes, '$.adk.first_source_event_id') AS first_source_event_id",
      "JSON_VALUE(attributes, '$.adk.last_source_event_id') AS last_source_event_id",
      "SAFE.TIMESTAMP_MICROS(SAFE_CAST(SAFE_CAST(JSON_VALUE(attributes, '$.adk.first_source_event_timestamp') AS FLOAT64) * 1000000 AS INT64)) AS first_source_event_timestamp",
      "SAFE.TIMESTAMP_MICROS(SAFE_CAST(SAFE_CAST(JSON_VALUE(attributes, '$.adk.last_source_event_timestamp') AS FLOAT64) * 1000000 AS INT64)) AS last_source_event_timestamp",
      "SAFE_CAST(JSON_VALUE(attributes, '$.adk.source_event_span_ms') AS FLOAT64) AS source_event_span_ms",
      "SAFE_CAST(JSON_VALUE(attributes, '$.adk.observed_event_count') AS INT64) AS observed_event_count",
      "SAFE_CAST(JSON_VALUE(attributes, '$.adk.node_interrupt_observed') AS BOOL) AS node_interrupt_observed",
      "SAFE_CAST(JSON_VALUE(attributes, '$.adk.descendant_interrupt_observed') AS BOOL) AS descendant_interrupt_observed",
      "SAFE_CAST(JSON_VALUE(attributes, '$.adk.node_error_observed_count') AS INT64) AS node_error_observed_count",
      "JSON_VALUE(attributes, '$.adk.drain_callback') AS drain_callback",
      "JSON_VALUE(attributes, '$.adk.boundary_basis') AS boundary_basis",
      "SAFE_CAST(JSON_VALUE(attributes, '$.adk.truncated_node_count') AS INT64) AS truncated_node_count",
    ],
  });

/** Options for creating analytics views. */
export interface CreateAnalyticsViewsOptions {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly viewPrefix: string;
  readonly bigquery?: BigQuery;
}

/**
 * Creates per-event-type BigQuery analytics views (idempotent).
 *
 * All 26 `EVENT_VIEW_DEFS` views from the shared BigQuery table contract are
 * created so cross-language queries and dashboards do not fail on missing view
 * names. A TypeScript agent in this scoped plugin version populates the 10
 * lifecycle event views (`INVOCATION_STARTING`, `INVOCATION_COMPLETED`,
 * `AGENT_STARTING`, `AGENT_COMPLETED`, `LLM_REQUEST`, `LLM_RESPONSE`,
 * `LLM_ERROR`, `TOOL_STARTING`, `TOOL_COMPLETED`, `TOOL_ERROR`), while the
 * remaining 16 views remain empty unless populated by Python agents sharing
 * the table.
 */
export async function createAnalyticsViews(
  options: CreateAnalyticsViewsOptions,
): Promise<boolean> {
  const sdks = await loadBigQuerySdks();
  const BigQuery = sdks.BigQuery;
  const bq = options.bigquery ?? new BigQuery({projectId: options.projectId});
  if (typeof (bq as {query?: unknown}).query !== 'function') {
    return true;
  }

  let createdAll = true;
  for (const entry of Object.entries(EVENT_VIEW_DEFS)) {
    const eventType = entry[0];
    const extraCols = entry[1];
    const viewName = `${options.viewPrefix}_${eventType.toLowerCase()}`;
    const columns = [...VIEW_COMMON_COLUMNS, ...extraCols].join(',\n  ');
    const sql = `CREATE OR REPLACE VIEW \`${options.projectId}.${options.datasetId}.${viewName}\` AS\nSELECT\n  ${columns}\nFROM\n  \`${options.projectId}.${options.datasetId}.${options.tableId}\`\nWHERE\n  event_type = '${eventType}'\n`;
    try {
      await bq.query(sql);
    } catch (err: unknown) {
      const code = extractCode(err);
      if (code === 409) {
        logger.debug(
          `View ${viewName} was updated concurrently by another process.`,
        );
      } else {
        createdAll = false;
        logger.error(
          `Failed to create view ${viewName}: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        );
      }
    }
  }
  return createdAll;
}

/** Options for ensuring table existence. */
export interface EnsureTableOptions {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly clusteringFields: readonly string[];
  readonly autoSchemaUpgrade?: boolean;
  readonly createViews?: boolean;
  readonly viewPrefix?: string;
  readonly bigquery?: BigQuery;
}

/**
 * Ensures the target events table exists with DAY time partitioning, clustering,
 * optional additive schema upgrade, and per-event-type analytics views.
 */
export async function ensureTable(options: EnsureTableOptions): Promise<void> {
  const sdks = await loadBigQuerySdks();
  const BigQuery = sdks.BigQuery;
  const bq = options.bigquery ?? new BigQuery({projectId: options.projectId});
  const dataset = bq.dataset(options.datasetId);
  const table = dataset.table(options.tableId);

  let existingTable: Table | undefined;
  try {
    const getRes = await table.get();
    existingTable = getRes[0];
  } catch (err: unknown) {
    const code = extractCode(err);
    if (code !== 404) {
      throw err;
    }
  }

  if (existingTable) {
    if (options.autoSchemaUpgrade ?? true) {
      await maybeUpgradeSchema(existingTable);
    }
    if (options.createViews) {
      await createAnalyticsViews({
        projectId: options.projectId,
        datasetId: options.datasetId,
        tableId: options.tableId,
        viewPrefix: options.viewPrefix ?? 'v',
        bigquery: bq,
      });
    }
    return;
  }

  const mutableSchema = {
    fields: JSON.parse(JSON.stringify(EVENTS_SCHEMA)),
  };

  try {
    await dataset.createTable(options.tableId, {
      schema: mutableSchema,
      timePartitioning: {type: 'DAY', field: 'timestamp'},
      clustering: {fields: [...options.clusteringFields]},
      labels: {[SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION},
    });
  } catch (err: unknown) {
    const code = extractCode(err);
    if (code === 409) {
      const getRes = await table.get();
      if (options.autoSchemaUpgrade ?? true) {
        await maybeUpgradeSchema(getRes[0]);
      }
    } else {
      throw err;
    }
  }

  if (options.createViews) {
    await createAnalyticsViews({
      projectId: options.projectId,
      datasetId: options.datasetId,
      tableId: options.tableId,
      viewPrefix: options.viewPrefix ?? 'v',
      bigquery: bq,
    });
  }
}

/** Adapter exposing write and close operations on the BigQuery Storage Write API. */
export interface StorageWriter {
  readonly writeRows: (rows: readonly EventRow[]) => Promise<AppendResult>;
  readonly close: () => Promise<void>;
}

/** Options for creating a StorageWriter. */
export interface CreateStorageWriterOptions {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly writerClient?: bqStorage.managedwriter.WriterClient;
  readonly jsonWriter?: bqStorage.managedwriter.JSONWriter;
}

/**
 * Creates a {@link StorageWriter} on the `_default` stream using `WriterClient` and `JSONWriter`.
 */
export async function createStorageWriter(
  options: CreateStorageWriterOptions,
): Promise<StorageWriter> {
  const sdks = await loadBigQuerySdks();
  const storage = sdks.storage;
  const managedwriter = storage.managedwriter;
  const adapt = storage.adapt;

  const destinationTable = `projects/${options.projectId}/datasets/${options.datasetId}/tables/${options.tableId}`;
  const writerClient = options.writerClient ?? new managedwriter.WriterClient();

  const storageSchema = adapt.convertBigQuerySchemaToStorageTableSchema({
    fields: JSON.parse(JSON.stringify(EVENTS_SCHEMA)),
  });
  const protoDescriptor = adapt.convertStorageSchemaToProto2Descriptor(
    storageSchema,
    'EventRow',
  );

  let jsonWriter: bqStorage.managedwriter.JSONWriter;
  if (options.jsonWriter) {
    jsonWriter = options.jsonWriter;
  } else {
    const connection = await writerClient.createStreamConnection({
      destinationTable,
      streamType: 'DEFAULT',
    });
    jsonWriter = new managedwriter.JSONWriter({
      connection,
      protoDescriptor,
      traceId: `google-adk-bq-logger/${version}`,
    });
  }

  return {
    writeRows: async (rows: readonly EventRow[]): Promise<AppendResult> => {
      // Cast EventRow to JSONWriter's expected JSONObject array
      const pendingWrite = jsonWriter.appendRows(
        rows as unknown as Parameters<
          bqStorage.managedwriter.JSONWriter['appendRows']
        >[0],
      );
      const response = await pendingWrite.getResult();
      return {
        error: response.error
          ? {
              code: response.error.code ?? undefined,
              message: response.error.message ?? undefined,
            }
          : undefined,
        rowErrors: response.rowErrors ?? undefined,
      };
    },
    close: async (): Promise<void> => {
      try {
        jsonWriter.close();
      } catch {
        // Ignore close errors
      }
      try {
        writerClient.close();
      } catch {
        // Ignore close errors
      }
    },
  };
}
