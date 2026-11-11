# BigQuery agent analytics (`BigQueryAgentAnalyticsPlugin`)

`BigQueryAgentAnalyticsPlugin` is a plugin in `@google/adk-integrations/bigquery` that logs agent events to a BigQuery table.

## Introduction

The plugin records user messages, LLM requests and responses, tool calls, agent lifecycle events, workflow nodes and human-in-the-loop events. It writes them to BigQuery through the Storage Write API.

It is a port of adk-python's `BigQueryAgentAnalyticsPlugin`. It writes the same table schema, schema version, JSON payloads and views, so Python and TypeScript agents can log into one `agent_events` table and share its views. The view SQL is pinned to adk-python at commit `3640e7d0`.

The plugin runs on Node.js only. The `@google-cloud/*` clients load lazily, the first time the plugin needs them.

## Installation and environment setup

The Google Cloud clients are optional peer dependencies of `@google/adk-integrations`. Install them alongside the package. They require Node.js 22 or later:

```bash
npm install @google/adk @google/adk-integrations @google-cloud/bigquery @google-cloud/bigquery-storage @google-cloud/storage
```

`@google-cloud/storage` is only needed when `gcsBucketName` is set.

The plugin authenticates with Application Default Credentials unless you pass your own clients:

```bash
gcloud auth application-default login
```

The dataset must exist. The plugin creates the table and views in it.

## Get started

Import the plugin from the `@google/adk-integrations/bigquery` subpath and register it on an `App` or a `Runner`:

```ts
import {App, InMemoryRunner, LlmAgent} from '@google/adk';
import {BigQueryAgentAnalyticsPlugin} from '@google/adk-integrations/bigquery';

const rootAgent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-flash-latest',
  instruction: 'Answer the user.',
});

const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
});

const app = new App({name: 'assistant', rootAgent, plugins: [analytics]});
const runner = new InMemoryRunner({app});

// Before the process exits:
await analytics.shutdown();
```

Call `shutdown()` before exit. It drains queued rows and closes the write streams, and it rejects if teardown fails. Without it, the process can exit with rows still queued, and those rows are lost: the plugin's timers do not hold the process open, and write connections close after 10 idle seconds.

Register the plugin before plugins that answer or re-raise tool callbacks, such as `ReflectAndRetryToolPlugin`. The plugin manager stops at the first plugin that returns a value.

## Configuration options

`new BigQueryAgentAnalyticsPlugin(options)` takes:

| Option        | Type                            | Default          | Description                                                                                                                                                             |
| :------------ | :------------------------------ | :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`   | `string`                        | Required         | Google Cloud project of the dataset.                                                                                                                                    |
| `datasetId`   | `string`                        | Required         | Existing BigQuery dataset.                                                                                                                                              |
| `tableId`     | `string`                        | `config.tableId` | Overrides `config.tableId`.                                                                                                                                             |
| `location`    | `string`                        | Unset            | Location for view DDL jobs. When unset, BigQuery uses the dataset's location.                                                                                           |
| `config`      | `Partial<BigQueryLoggerConfig>` | See below        | Logger settings.                                                                                                                                                        |
| `bigQuery`    | `BigQuery`                      | Built from ADC   | BigQuery client for table and view setup.                                                                                                                               |
| `storage`     | `Storage`                       | Built from ADC   | Cloud Storage client for offloaded content.                                                                                                                             |
| `writeClient` | `managedwriter.WriterClient`    | Built from ADC   | Storage Write API client. The plugin never closes a supplied client, so connections it abandoned with an unacknowledged request stay in that client until you close it. |

`config` mirrors adk-python's `BigQueryLoggerConfig` field for field, in camelCase (`batch_flush_interval` becomes `batchFlushInterval`), except `credentials_identifier`, which has no adk-js equivalent. Durations are in seconds. Commonly used fields:

| Field                 | Default                              | Description                                                                                   |
| :-------------------- | :----------------------------------- | :-------------------------------------------------------------------------------------------- |
| `tableId`             | `'agent_events'`                     | Events table.                                                                                 |
| `eventAllowlist`      | `null`                               | Event types to log. `null` logs all of them.                                                  |
| `eventDenylist`       | `null`                               | Event types to skip.                                                                          |
| `batchSize`           | `1`                                  | Rows per append.                                                                              |
| `batchFlushInterval`  | `1`                                  | Seconds before a partial batch is written.                                                    |
| `queueMaxSize`        | `10000`                              | Rows held in memory. Rows past this are dropped and counted.                                  |
| `shutdownTimeout`     | `10`                                 | Seconds `shutdown()` waits for queued rows.                                                   |
| `flushOnRunEnd`       | `true`                               | Wait, up to `shutdownTimeout`, for a run's rows when the run ends.                            |
| `maxContentLength`    | `512000`                             | Code points of text kept per field before it is truncated or offloaded. `-1` keeps all of it. |
| `gcsBucketName`       | `null`                               | Bucket for large text and binary content parts.                                               |
| `clusteringFields`    | `['event_type', 'agent', 'user_id']` | Clustering of a newly created table.                                                          |
| `autoSchemaUpgrade`   | `true`                               | Add missing columns to an existing table.                                                     |
| `createViews`         | `true`                               | Create one view per event type, named with `viewPrefix` (`'v'`).                              |
| `createEvalViews`     | `false`                              | Also create the evaluation views.                                                             |
| `exactlyOnceDelivery` | `false`                              | Write through committed streams with offsets instead of the default stream.                   |
| `customTags`          | `{}`                                 | Tags added to every row.                                                                      |

## How it works

1. **Setup**: on first use the plugin creates the events table in the dataset (day-partitioned and clustered), upgrades an older schema additively and creates the views. A failed view does not stop rows from being written.
2. **Callbacks**: each plugin callback builds a row with the event type, agent, session, user, invocation, trace and span ids, latency and a JSON payload. Content is sanitized for credentials and truncated or offloaded to Cloud Storage.
3. **Batching**: rows go to an in-memory queue. One worker writes batches through the Storage Write API and retries transient failures with backoff. Rows that cannot be written are dropped and counted by reason.
4. **Shutdown**: `shutdown()` flushes the queue and closes the write streams and any clients the plugin created.

## Differences from adk-python

| adk-python                                                                      | adk-js                                                      | Why                                                                                                                                                                                                             |
| :------------------------------------------------------------------------------ | :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arrow record batches                                                            | Storage Write API protobuf rows                             | The Node.js client has no Arrow path. Rows and streams are the same. The `arrow_prep_failed` drop reason keeps its name.                                                                                        |
| Span stack in a `contextvar`                                                    | Span stack keyed by invocation, branch and function call id | Plugin callbacks cannot carry async-local state back to the runner.                                                                                                                                             |
| Background loop thread, fork handling, `atexit` drain, `credentials_identifier` | Not ported                                                  | Node.js runs one event loop per process. Call `shutdown()` before exit.                                                                                                                                         |
| `TOOLBOX` tool origin                                                           | Toolbox tools are reported as `LOCAL`                       | Core cannot yet tell which tools a `ToolboxToolset` loaded ([#1250](https://github.com/google/adk-js/pull/1250)). |
| An unacknowledged append on the default stream counts as written                | Retried, then counted as `retry_exhausted`                  | Rows carry `event_id`, so a retry can be deduplicated.                                                            |
| `ValueError` on invalid config                                                  | `RangeError`                                                |                                                                                                                   |

## Related guides

- [Runners](../../../runners/index.md) - `Runner`, `InMemoryRunner` and running an `App` with plugins.
- [Telemetry](../../../telemetry/index.md) - Tracing in ADK. Set `enableOtelCorrelation` to correlate rows with OpenTelemetry spans.

## Related samples

- [BigQuery agent analytics](../../../../../samples/integrations/bigquery_agent_analytics/README.md) - An `App` that logs its events to BigQuery.
