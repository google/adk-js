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

## Divergences from adk-python

The goldens follow adk-python's telemetry schema v2 goldens for the same
scenario and case. Every place where an adk-js golden deliberately differs is
listed, with its reason, in
[`./functional_divergences.json`](./functional_divergences.json). That file
sits in this directory rather than inside a scenario directory, because each
scenario test suite treats every `.json` file in its directory as a golden. When
a re-recorded golden changes, check that each remaining difference from
adk-python is listed there.
