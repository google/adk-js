# Telemetry Integration Goldens

Each scenario directory under `tests/integration/telemetry/` contains an
`agent.ts` scenario definition, an `agent_test.ts` test suite, and the `.json`
golden files that record the OpenTelemetry surface (`root_span` tree with
attributes, status, and nested log records, plus `metric_points` grouped by
metric name) emitted under each telemetry environment configuration.

## Re-recording Goldens

After an intentional telemetry change, re-record every golden from the
repository root with:

```bash
ADK_UPDATE_TELEMETRY_GOLDENS=1 npx vitest run --project integration tests/integration/telemetry
```

Then run `npm test` and inspect `git diff tests/integration/telemetry/` to
review the resulting telemetry changes.
