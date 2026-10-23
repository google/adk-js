# ADK Integrations

This package contains integrations for the Google ADK.

## BigQuery Agent Analytics

`BigQueryAgentAnalyticsPlugin` logs agent events (user messages, LLM requests
and responses, tool calls, agent lifecycle, human-in-the-loop) to a BigQuery
table through the Storage Write API. It is a port of adk-python's
`BigQueryAgentAnalyticsPlugin` and writes the same table schema, schema version,
JSON payloads and views, so Python and TypeScript agents can log into one
`agent_events` table and share its views. It runs on Node.js only.

```typescript
import {InMemoryRunner} from '@google/adk';
import {BigQueryAgentAnalyticsPlugin} from '@google/adk-integrations';

const plugin = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
  location: 'US',
});
const runner = new InMemoryRunner({agent, plugins: [plugin]});

// Before the process exits:
await plugin.shutdown();
```

The plugin authenticates with Application Default Credentials unless you pass
`bigQuery`, `storage` or `writeClient` clients. On first use it creates the
events table in an existing dataset (day-partitioned and clustered), upgrades an
older schema additively and creates one view per event type.

`config` mirrors adk-python's `BigQueryLoggerConfig` field for field, in
camelCase (`batch_flush_interval` becomes `batchFlushInterval`). Durations are
in seconds.

### Differences from adk-python

| adk-python                                            | adk-js                                                      | Why                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Arrow record batches                                  | Storage Write API protobuf rows                             | The Node.js client has no Arrow path. Rows and streams are the same. The `arrow_prep_failed` drop reason keeps its name.           |
| Span stack in a `contextvar`                          | Span stack keyed by invocation, branch and function call id | Plugin callbacks cannot carry async-local state back to the runner.                                                                |
| Background loop thread, fork handling, `atexit` drain | Not ported                                                  | Node.js runs one event loop per process. Call `shutdown()` before exit.                                                            |
| `on_agent_error_callback`, `on_run_error_callback`    | Public `onAgentErrorCallback`, `onRunErrorCallback`         | `BasePlugin` has no error hooks for agents and runs, so the runner never calls them.                                               |
| `AGENT_STARTING` / `AGENT_COMPLETED` rows             | Implemented, not emitted                                    | The runner does not call plugin `beforeAgentCallback` / `afterAgentCallback`.                                                      |
| `INVOCATION_COMPLETED` on completed and aborted runs  | Only on completed runs                                      | The runner skips `afterRunCallback` when a run is aborted. Span state of a run that never completes is dropped after 6 idle hours. |
| `ValueError` on invalid config                        | `RangeError`                                                |                                                                                                                                    |
