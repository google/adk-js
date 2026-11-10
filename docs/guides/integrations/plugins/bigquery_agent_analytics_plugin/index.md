# BigQuery Agent Analytics Plugin (`BigQueryAgentAnalyticsPlugin`)

The `BigQueryAgentAnalyticsPlugin` in `@google/adk-integrations` records ADK agent lifecycle events (runs, agents, model interactions, and tool executions) to a Google Cloud BigQuery table.

The BigQuery table schema, column names, data types, and attribute representations match the format used across the Agent Development Kit, enabling shared queries, metric dashboards, and analytics across multilingual agent deployments.

## Installation

The BigQuery client libraries are optional peer dependencies of `@google/adk-integrations`. Install them in your project:

```bash
npm install @google-cloud/bigquery @google-cloud/bigquery-storage
```

Ensure Application Default Credentials (ADC) or a service account key with BigQuery Data Editor and BigQuery Job User roles is available:

```bash
gcloud auth application-default login
```

## Quick Start

```typescript
import {InMemoryRunner, LlmAgent} from '@google/adk';
import {BigQueryAgentAnalyticsPlugin} from '@google/adk-integrations';

const analyticsPlugin = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-gcp-project',
  datasetId: 'agent_analytics',
  tableId: 'agent_events',
  config: {
    batchSize: 10,
    batchFlushInterval: 2.0,
    flushOnRunEnd: true,
  },
});

const runner = new InMemoryRunner({
  agent,
  plugins: [analyticsPlugin],
});

// Run agent invocations
for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: 'session-1',
  newMessage: {parts: [{text: 'Hello assistant'}]},
})) {
  // handle events
}

// Drain remaining events and close writer
await analyticsPlugin.shutdown();
```

## Configuration

Options are configured via `BigQueryLoggerConfig` passed to constructor options:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | When `false`, logging is disabled and BigQuery SDKs are never loaded. |
| `tableId` | `string` | `'agent_events'` | Destination BigQuery table ID. |
| `clusteringFields` | `readonly string[]` | `['event_type', 'agent', 'user_id']` | Table clustering fields applied when creating a new table. |
| `maxContentLength` | `number` | `524288` (512 KB) | Maximum character length for serialized text payloads before truncation, or `-1` for unlimited. |
| `logMultiModalContent` | `boolean` | `true` | Whether to populate the `content_parts` repeated record column. |
| `batchSize` | `number` | `1` | Number of events buffered before writing a batch. |
| `batchFlushInterval` | `number` | `1.0` | Maximum time in seconds a queued row waits before an automatic batch flush. |
| `shutdownTimeout` | `number` | `10.0` | Maximum time in seconds `shutdown()` waits for queued rows to drain. |
| `queueMaxSize` | `number` | `10000` | Maximum queued events. High-water reserve slots protect terminal turn events. |
| `flushOnRunEnd` | `boolean` | `true` | Whether to flush queued rows immediately when `afterRunCallback` executes. |
| `logSessionMetadata` | `boolean` | `true` | Whether to include session ID, user ID, and state in `attributes.session_metadata`. |
| `customTags` | `Record<string, unknown>` | `{}` | Static key-value tags attached to `attributes.custom_tags` on every row. |
| `enableOtelCorrelation` | `boolean` | `false` | Whether to copy active OpenTelemetry span and trace IDs to `attributes.otel`. |
| `autoSchemaUpgrade` | `boolean` | `true` | Whether to automatically add missing columns to an existing events table. |
| `createViews` | `boolean` | `true` | Whether to automatically create per-event-type BigQuery analytics views. |
| `viewPrefix` | `string` | `'v'` | Prefix for auto-created per-event-type view names (e.g., `'v'` creates `v_llm_request`). |
| `eventAllowlist` | `readonly string[]` | `undefined` | Optional allowlist of event type names to record. |
| `eventDenylist` | `readonly string[]` | `undefined` | Optional denylist of event type names to skip. |
| `retryConfig.maxRetries` | `number` | `3` | Maximum retry attempts for transient write failures. |
| `retryConfig.initialDelay`| `number` | `1.0` | Initial delay in seconds before the first retry. |
| `retryConfig.multiplier` | `number` | `2.0` | Exponential backoff multiplier. |
| `retryConfig.maxDelay` | `number` | `10.0` | Upper bound ceiling in seconds for single retry delay. |

> [!NOTE]
> All duration settings (`batchFlushInterval`, `shutdownTimeout`, `initialDelay`, `maxDelay`) are specified in **seconds**.

## Events Logged

| Event Type | Lifecycle Callback | Payload Content |
| :--- | :--- | :--- |
| `INVOCATION_STARTING` | `beforeRunCallback` | User input message payload. |
| `INVOCATION_COMPLETED` | `afterRunCallback` | Empty payload; records turn total latency. |
| `AGENT_STARTING` | `beforeAgentCallback` | Agent instructions (or null for instruction providers). |
| `AGENT_COMPLETED` | `afterAgentCallback` | Empty payload; records agent total latency. |
| `LLM_REQUEST` | `beforeModelCallback` | Prompts, system instructions, and tool configurations. |
| `LLM_RESPONSE` | `afterModelCallback` | Model response content, token counts, and token latency. |
| `LLM_ERROR` | `onModelErrorCallback` | Error diagnosis and failure message. |
| `TOOL_STARTING` | `beforeToolCallback` | Tool name, call arguments, and origin (`LOCAL`, `SUB_AGENT`, `A2A`, `MCP`, `TRANSFER_AGENT`, `TRANSFER_A2A`, `TOOLBOX`, `SKILL`, or `UNKNOWN`). |
| `TOOL_COMPLETED` | `afterToolCallback` | Tool execution results and origin. |
| `TOOL_ERROR` | `onToolErrorCallback` | Tool execution failure details. |

> [!NOTE]
> `PluginManager.runBeforeAgentCallback` and `runAfterAgentCallback` currently have no callers in `@google/adk` `Runner` / `BaseAgent`, so `AGENT_STARTING` and `AGENT_COMPLETED` are not emitted automatically during a standard `Runner` turn. Model and tool spans parent directly to the `invocation` span unless `beforeAgentCallback` and `afterAgentCallback` are invoked explicitly.

## BigQuery Table Schema

When the configured table does not exist, the plugin creates it automatically with `DAY` partitioning on `timestamp`, clustering on `clusteringFields`, and the label `adk_schema_version=2`. When `createViews` is enabled (the default), the plugin creates all 26 per-event-type views (`{viewPrefix}_{event_type}`) from the shared table contract so cross-language queries and dashboards do not fail on missing view names. A TypeScript agent only populates the 10 lifecycle event views listed in `Events Logged`; the remaining 16 views (`USER_MESSAGE_RECEIVED`, `STATE_DELTA`, `HITL_*`, `AGENT_RESPONSE`, `AGENT_TRANSFER`, `TOOL_PAUSED`, `NODE_*`, `WORKFLOW_NODE_*`, `INVOCATION_ERROR`, `AGENT_ERROR`, `EVENT_COMPACTION`, `AGENT_STATE_CHECKPOINT`, `A2A_INTERACTION`) remain empty unless populated by Python agents sharing the table.

| Column | Type | Mode | Description |
| :--- | :--- | :--- | :--- |
| `timestamp` | `TIMESTAMP` | `REQUIRED` | UTC event creation timestamp. Primary partition key. |
| `event_id` | `STRING` | `NULLABLE` | Unique 32-character hexadecimal identifier. |
| `event_type` | `STRING` | `NULLABLE` | Lifecycle event category (e.g. `LLM_REQUEST`, `TOOL_COMPLETED`). |
| `agent` | `STRING` | `NULLABLE` | Name of the generating agent. |
| `session_id` | `STRING` | `NULLABLE` | Session identifier. |
| `invocation_id` | `STRING` | `NULLABLE` | Turn identifier within a session. |
| `user_id` | `STRING` | `NULLABLE` | End-user identifier. |
| `trace_id` | `STRING` | `NULLABLE` | Correlation trace ID across services. |
| `span_id` | `STRING` | `NULLABLE` | Execution tree span identifier. |
| `parent_span_id` | `STRING` | `NULLABLE` | Parent span identifier linking the execution hierarchy. |
| `content` | `JSON` | `NULLABLE` | Event-specific JSON payload. |
| `content_parts` | `RECORD` | `REPEATED` | Multi-modal content parts (`mime_type`, `uri`, `text`, `storage_mode`, etc.). |
| `attributes` | `JSON` | `NULLABLE` | Metadata envelope including `adk`, `root_agent_name`, and token usage. |
| `latency_ms` | `JSON` | `NULLABLE` | Latency measurements (`total_ms`, `time_to_first_token_ms`). |
| `status` | `STRING` | `NULLABLE` | Event status (`'OK'` or `'ERROR'`). |
| `error_message` | `STRING` | `NULLABLE` | Sanitized diagnostic error message. |
| `is_truncated` | `BOOLEAN` | `NULLABLE` | Flag indicating whether payloads were truncated to size bounds. |

## Trace Correlation

1. **`trace_id`**: Inherits the active OpenTelemetry ambient trace ID from `trace.getActiveSpan()`. When running without an ambient tracer, generates a stable 32-character hexadecimal ID shared by all events in the invocation.
2. **`span_id` and `parent_span_id`**: Form the hierarchical tree of operations (`invocation -> model / tool` during standard `Runner` turns, or `invocation -> agent -> model / tool` when `beforeAgentCallback` and `afterAgentCallback` are invoked). On invocation roots, `span_id` mirrors the ambient OpenTelemetry root span ID.
3. **`attributes.otel`**: When `enableOtelCorrelation: true` is configured, each row records `{span_id, trace_id}` of the ambient OpenTelemetry span active at callback execution time.

## Reliability and Drop Stats

Event logging never throws errors that interrupt the user's agent execution. If BigQuery is unavailable or credentials fail, events are safely dropped and recorded in internal diagnostic counters accessible via `getDropStats()`:

```typescript
const stats = analyticsPlugin.getDropStats();
console.log(`Queue full drops: ${stats.queue_full}`);
console.log(`Exhausted retries: ${stats.retry_exhausted}`);
console.log(`Setup unavailable: ${stats.setup_unavailable}`);
```

## Shutdown

Call `shutdown()` during application teardown to flush pending batches and release network writers:

```typescript
await analyticsPlugin.shutdown(15.0); // 15-second drain deadline
```

The internal batch timer uses `unref()` so it does not block the Node.js event loop from exiting.

## Example Query: Agent Latency and Token Usage

Analyze operational performance, total tokens, and average latencies grouped by agent over the past 7 days:

```sql
SELECT
  agent,
  COUNTIF(event_type = 'LLM_REQUEST') AS total_llm_requests,
  ROUND(AVG(CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64)), 2) AS avg_turn_latency_ms,
  ROUND(AVG(CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64)), 2) AS avg_ttft_ms,
  SUM(CAST(JSON_VALUE(attributes, '$.usage_metadata.prompt_token_count') AS INT64)) AS total_prompt_tokens,
  SUM(CAST(JSON_VALUE(attributes, '$.usage_metadata.candidates_token_count') AS INT64)) AS total_completion_tokens
FROM
  `my-gcp-project.agent_analytics.agent_events`
WHERE
  timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND status = 'OK'
GROUP BY
  agent
ORDER BY
  total_llm_requests DESC;
```
