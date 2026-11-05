# ADK Integrations

This package contains integrations for the Google ADK.

## BigQuery Agent Analytics

`BigQueryAgentAnalyticsPlugin` logs agent events (user messages, LLM requests
and responses, tool calls, agent lifecycle, workflow nodes, human-in-the-loop)
to a BigQuery table through the Storage Write API. It is a port of adk-python's
`BigQueryAgentAnalyticsPlugin` and writes the same table schema, schema version,
JSON payloads and views, so Python and TypeScript agents can log into one
`agent_events` table and share its views. The view SQL is pinned to adk-python
at commit `3640e7d0`. It runs on Node.js only.

The Google Cloud clients are optional peer dependencies. Install them alongside
this package (they require Node.js 22 or later):

```bash
npm install @google/adk-integrations @google-cloud/bigquery @google-cloud/bigquery-storage @google-cloud/storage
```

```typescript
import {InMemoryRunner} from '@google/adk';
import {BigQueryAgentAnalyticsPlugin} from '@google/adk-integrations';

const plugin = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
});
const runner = new InMemoryRunner({agent, plugins: [plugin]});

// Before the process exits:
await plugin.shutdown();
```

Call `shutdown()` before exit: it drains queued rows and closes the write
streams, and it rejects if teardown fails. Without it, the process can exit
with rows still queued, and those rows are lost: the plugin's timers do not hold
the process open, and write connections close after 10 idle seconds.

The plugin authenticates with Application Default Credentials unless you pass
`bigQuery`, `storage` or `writeClient` clients. On first use it creates the
events table in an existing dataset (day-partitioned and clustered), upgrades an
older schema additively and creates one view per event type. A failed view does
not stop rows from being written. `location` is optional; when it is omitted,
BigQuery uses the dataset's location.

`config` mirrors adk-python's `BigQueryLoggerConfig` field for field, in
camelCase (`batch_flush_interval` becomes `batchFlushInterval`), except
`credentials_identifier`, which has no adk-js equivalent. Durations are in
seconds.

### Differences from adk-python

| adk-python                                                                      | adk-js                                                      | Why                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arrow record batches                                                            | Storage Write API protobuf rows                             | The Node.js client has no Arrow path. Rows and streams are the same. The `arrow_prep_failed` drop reason keeps its name.                                                                                        |
| Span stack in a `contextvar`                                                    | Span stack keyed by invocation, branch and function call id | Plugin callbacks cannot carry async-local state back to the runner.                                                                                                                                             |
| Background loop thread, fork handling, `atexit` drain, `credentials_identifier` | Not ported                                                  | Node.js runs one event loop per process. Call `shutdown()` before exit.                                                                                                                                         |
| `on_agent_error_callback`, `on_run_error_callback`                              | Public `onAgentErrorCallback`, `onRunErrorCallback`         | `BasePlugin` has no error hooks for agents and runs, so the runner never calls them ([#1132](https://github.com/google/adk-js/issues/1132)).                                                                    |
| `AGENT_STARTING` / `AGENT_COMPLETED` rows                                       | Implemented, not emitted                                    | The runner does not call plugin `beforeAgentCallback` / `afterAgentCallback` ([#1131](https://github.com/google/adk-js/issues/1131)). Eval views therefore do not require `AGENT_STARTING` in `eventAllowlist`. |
| `INVOCATION_COMPLETED` on completed and aborted runs                            | Only on completed runs                                      | The runner skips `afterRunCallback` when a run is aborted. Span state of a run that never completes is evicted after 6 idle hours or past 10,000 tracked invocations.                                           |
| An unacknowledged append on the default stream counts as written                | Retried, then counted as `retry_exhausted`                  | Rows carry `event_id`, so a retry can be deduplicated.                                                                                                                                                          |
| `ValueError` on invalid config                                                  | `RangeError`                                                |                                                                                                                                                                                                                 |
