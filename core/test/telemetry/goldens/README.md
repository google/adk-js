# Telemetry Functional Goldens

Each `.json` file under this directory records the OpenTelemetry surface
(`root_span` tree with attributes, status, and nested log records, plus
`metric_points` grouped by metric name) emitted by one scenario under one
telemetry environment configuration.

## Re-recording Goldens

After an intentional telemetry change, re-record every golden from the
repository root with:

```bash
ADK_UPDATE_TELEMETRY_GOLDENS=1 npx vitest run --project unit:core core/test/telemetry/functional_test.ts
```

Then run `npm test` and inspect `git diff core/test/telemetry/goldens/` to
review the resulting telemetry changes.

## Divergences from adk-python

The goldens follow adk-python's telemetry schema v2 goldens for the same
scenario and case. Every place where an adk-js golden deliberately differs is
listed, with its reason, in
[`../functional_divergences.json`](../functional_divergences.json). That file
sits beside this directory rather than in it, because the golden suite treats
every `.json` file here as a golden. When a re-recorded golden changes, check
that each remaining difference from adk-python is listed there.
