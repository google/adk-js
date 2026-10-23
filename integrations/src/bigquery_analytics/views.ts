/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type BigQueryLoggerConfig, type EvalViewMode} from './config.js';
import {
  EVAL_SESSION_VIEW_SQL_TEMPLATE,
  EVAL_TURN_VIEW_SQL_TEMPLATE,
  EVAL_VIEW_CTES_SQL,
} from './eval_view_sql.js';
import {pythonList} from './schema.js';

/** Columns included in every per-event-type view. */
const VIEW_COMMON_COLUMNS: ReadonlyArray<string> = [
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
];

/**
 * Per-event-type `"SQL_EXPR AS alias"` columns appended after the common ones;
 * the key order is the creation order.
 */
/** View name suffix (lowercased event type) to its extra columns. */
export type EventViewDefs = Readonly<Record<string, ReadonlyArray<string>>>;

export const EVENT_VIEW_DEFS = {
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
    String.raw`COALESCE(JSON_VALUE(content, '$.text_summary'), IF(REGEXP_CONTAINS(JSON_VALUE(content, '$'), r'^(?:<(?:function|bound method) |<.+ at 0x[0-9a-fA-F]+>|functools\.partial\()'), NULL, JSON_VALUE(content, '$'))) AS agent_instruction`,
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
  NODE_OUTPUT: [
    "JSON_VALUE(attributes, '$.adk.node.path') AS node_path",
    "JSON_VALUE(attributes, '$.adk.node.run_id') AS node_run_id",
    "JSON_VALUE(attributes, '$.adk.node.parent_run_id') AS node_parent_run_id",
    'content AS output',
  ],
  NODE_ERROR: [
    "JSON_VALUE(attributes, '$.adk.node.path') AS node_path",
    "JSON_VALUE(attributes, '$.adk.node.run_id') AS node_run_id",
    "JSON_VALUE(attributes, '$.adk.node.parent_run_id') AS node_parent_run_id",
    "JSON_VALUE(content, '$.error_code') AS error_code",
  ],
} satisfies EventViewDefs;

const VIEW_SQL_TEMPLATE = `CREATE OR REPLACE VIEW \`{project}.{dataset}.{view_name}\` AS
SELECT
  {columns}
FROM
  \`{project}.{dataset}.{table}\`
WHERE
  event_type = '{event_type}'
`;

/** Events the eval views rebuild an `AgentData` trace from in `full` mode. */
export const EVAL_VIEW_REQUIRED_EVENTS: ReadonlySet<string> = new Set([
  'USER_MESSAGE_RECEIVED',
  'AGENT_STARTING',
  'LLM_REQUEST',
  'TOOL_STARTING',
  'TOOL_COMPLETED',
  'TOOL_PAUSED',
  'AGENT_TRANSFER',
  'HITL_CREDENTIAL_REQUEST',
  'HITL_CONFIRMATION_REQUEST',
  'HITL_INPUT_REQUEST',
  'HITL_CREDENTIAL_REQUEST_COMPLETED',
  'HITL_CONFIRMATION_REQUEST_COMPLETED',
  'HITL_INPUT_REQUEST_COMPLETED',
  'AGENT_RESPONSE',
  'INVOCATION_COMPLETED',
]);

/** The events a conversation's user and model text come from. */
const EVAL_VIEW_CORE_EVENTS: ReadonlySet<string> = new Set([
  'USER_MESSAGE_RECEIVED',
  'AGENT_RESPONSE',
  'INVOCATION_COMPLETED',
]);

const EVAL_VIEW_EVENTS_BY_MODE: Readonly<
  Record<EvalViewMode, ReadonlySet<string>>
> = {
  full: EVAL_VIEW_REQUIRED_EVENTS,
  conversation_only: EVAL_VIEW_CORE_EVENTS,
};

function isEvalViewMode(mode: string): mode is EvalViewMode {
  return mode === 'full' || mode === 'conversation_only';
}

/**
 * Renders a Python `str.format` template: `{name}` substitutes, `{{` and `}}`
 * are literal braces.
 */
export function formatSqlTemplate({
  template,
  values,
}: {
  template: string;
  values: Readonly<Record<string, string>>;
}): string {
  return template.replaceAll(
    /\{\{|\}\}|\{([A-Za-z_]+)\}/g,
    (match, name: string | undefined) => {
      if (name === undefined) {
        return match.slice(0, 1);
      }
      const value = values[name];
      if (value === undefined) {
        throw new RangeError(`Missing SQL template value '${name}'.`);
      }
      return value;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Drops derived view columns that reference a denied payload column, which
 * would otherwise make the view reference a column the table does not have.
 */
export function projectViewColumns({
  columns,
  denied,
}: {
  columns: ReadonlyArray<string>;
  denied: ReadonlySet<string>;
}): Array<string> {
  if (denied.size === 0) {
    return [...columns];
  }
  const patterns = [...denied].map(
    (column) => new RegExp(String.raw`\b${escapeRegExp(column)}\b`),
  );
  return columns.filter(
    (expression) => !patterns.some((pattern) => pattern.test(expression)),
  );
}

export interface ViewStatement {
  viewName: string;
  sql: string;
}

/**
 * Builds the `CREATE OR REPLACE VIEW` statement of every per-event-type view,
 * in creation order.
 */
export function analyticsViewStatements({
  projectId,
  datasetId,
  tableId,
  viewPrefix,
  denied,
}: {
  projectId: string;
  datasetId: string;
  tableId: string;
  viewPrefix: string;
  denied: ReadonlySet<string>;
}): Array<ViewStatement> {
  return Object.entries(EVENT_VIEW_DEFS).map(([eventType, extraColumns]) => {
    const viewName = `${viewPrefix}_${eventType.toLowerCase()}`;
    const columns = [
      ...VIEW_COMMON_COLUMNS,
      ...projectViewColumns({columns: extraColumns, denied}),
    ].join(',\n  ');
    return {
      viewName,
      sql: formatSqlTemplate({
        template: VIEW_SQL_TEMPLATE,
        values: {
          project: projectId,
          dataset: datasetId,
          view_name: viewName,
          columns,
          table: tableId,
          event_type: eventType,
        },
      }),
    };
  });
}

function evalViewDatasetRef({
  fullTableId,
  denied,
}: {
  fullTableId: string;
  denied: ReadonlySet<string>;
}): string {
  if (denied.has('content')) {
    throw new RangeError(
      "Cannot build eval view SQL when 'content' is in payload_column_denylist.",
    );
  }
  const dot = fullTableId.lastIndexOf('.');
  const datasetRef = dot === -1 ? '' : fullTableId.slice(0, dot);
  const table = fullTableId.slice(dot + 1);
  if (datasetRef === '' || table === '') {
    throw new RangeError(
      `full_table_id must be a dataset-qualified table name such as 'project.dataset.table'; got '${fullTableId}'.`,
    );
  }
  return datasetRef;
}

function buildEvalViewCtes({
  fullTableId,
  denied,
  scopeColumns,
}: {
  fullTableId: string;
  denied: ReadonlySet<string>;
  scopeColumns: string;
}): string {
  return formatSqlTemplate({
    template: EVAL_VIEW_CTES_SQL,
    values: {
      full_table_id: fullTableId,
      content_parts_column: denied.has('content_parts')
        ? 'ARRAY<STRUCT<part_index INT64, mime_type STRING, text STRING, part_attributes STRING, storage_mode STRING>>[] AS content_parts'
        : 'content_parts',
      attributes_column: denied.has('attributes')
        ? 'CAST(NULL AS JSON) AS attributes'
        : 'attributes',
      latency_ms_column: denied.has('latency_ms')
        ? 'CAST(NULL AS JSON) AS latency_ms'
        : 'latency_ms',
      scope_columns: scopeColumns,
    },
  });
}

export interface EvalViewParams {
  /**
   * The events table as `project.dataset.table`; the view is created in the
   * same dataset.
   */
  fullTableId: string;
  viewPrefix?: string;
  /** Payload columns projected out of the table. */
  denied?: ReadonlySet<string>;
}

/**
 * Builds the `{viewPrefix}_eval_session` view: one row per session, whose
 * `trace` column is an `AgentData` object holding every turn of the session,
 * numbered from 0 in start order.
 */
export function buildEvalSessionViewSql({
  fullTableId,
  viewPrefix = 'v',
  denied = new Set(),
}: EvalViewParams): string {
  const datasetRef = evalViewDatasetRef({fullTableId, denied});
  return formatSqlTemplate({
    template: EVAL_SESSION_VIEW_SQL_TEMPLATE,
    values: {
      view_ref: `${datasetRef}.${viewPrefix}_eval_session`,
      ctes: buildEvalViewCtes({
        fullTableId,
        denied,
        scopeColumns: 'session_id',
      }),
    },
  });
}

/**
 * Builds the `{viewPrefix}_eval_turn` view: one row per turn, whose `trace`
 * holds only that turn with `turn_index` 0, as single-turn metrics require; the
 * `turn_index` column keeps its position in the session.
 */
export function buildEvalTurnViewSql({
  fullTableId,
  viewPrefix = 'v',
  denied = new Set(),
}: EvalViewParams): string {
  const datasetRef = evalViewDatasetRef({fullTableId, denied});
  return formatSqlTemplate({
    template: EVAL_TURN_VIEW_SQL_TEMPLATE,
    values: {
      view_ref: `${datasetRef}.${viewPrefix}_eval_turn`,
      ctes: buildEvalViewCtes({
        fullTableId,
        denied,
        scopeColumns: 'session_id, invocation_id',
      }),
    },
  });
}

/**
 * Rejects a config whose table cannot feed the eval views: `content` denied, an
 * unknown `evalViewMode`, or a required event filtered out by `eventDenylist` /
 * `eventAllowlist`. An empty allowlist means "unset".
 */
export function validateEvalViewConfig({
  config,
  denied,
  fromInit,
}: {
  config: Pick<
    BigQueryLoggerConfig,
    'evalViewMode' | 'eventDenylist' | 'eventAllowlist'
  >;
  denied: ReadonlySet<string>;
  fromInit: boolean;
}): void {
  const prefix = fromInit
    ? 'BigQueryLoggerConfig.createEvalViews=true cannot be used'
    : 'Cannot create eval views';
  if (denied.has('content')) {
    throw new RangeError(
      `${prefix} when 'content' is in payloadColumnDenylist, because AgentData trace reconstruction requires the 'content' column.`,
    );
  }
  const mode: string = config.evalViewMode;
  if (!isEvalViewMode(mode)) {
    throw new RangeError(
      `${prefix} with unknown evalViewMode='${mode}'; expected one of ${pythonList(Object.keys(EVAL_VIEW_EVENTS_BY_MODE))}.`,
    );
  }
  const requiredEvents = EVAL_VIEW_EVENTS_BY_MODE[mode];
  const deniedEvents = (config.eventDenylist ?? []).filter((event) =>
    requiredEvents.has(event),
  );
  if (deniedEvents.length > 0) {
    throw new RangeError(
      `${prefix} when required events are in eventDenylist: ${pythonList(new Set(deniedEvents))}.`,
    );
  }
  const allowlist = config.eventAllowlist ?? [];
  if (allowlist.length === 0) {
    return;
  }
  const missingEvents = [...requiredEvents].filter(
    (event) => !allowlist.includes(event),
  );
  if (missingEvents.length === 0) {
    return;
  }
  const hint =
    mode === 'full'
      ? " Set evalViewMode='conversation_only' if tool, model-request, agent-handoff, or HITL events are intentionally omitted."
      : '';
  throw new RangeError(
    `${prefix} unless eventAllowlist includes all required events; missing: ${pythonList(missingEvents)}.${hint}`,
  );
}
