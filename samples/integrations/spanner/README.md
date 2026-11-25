# Spanner Toolset Sample (`SpannerToolset`)

This sample demonstrates how to equip an `LlmAgent` with `SpannerToolset`, `SpannerCredentialsConfig`, and `SpannerToolSettings` from `@google/adk-integrations`.

## Overview

`spannerDataAssistant` is an `LlmAgent` configured with:

1. `SpannerCredentialsConfig` for OAuth2 client credentials and default `SPANNER_DEFAULT_SCOPE` (`https://www.googleapis.com/auth/spanner.admin` and `https://www.googleapis.com/auth/spanner.data`).
2. `SpannerToolSettings` enabling `SpannerCapabilities.DATA_READ` and capping query results at `50` rows (`maxExecutedQueryResultRows`).
3. `SpannerToolset` exposing `list_table_names`, `get_table_schema`, `list_table_indexes`, `list_table_index_columns`, `list_named_schemas`, and `execute_sql` (prefixed with `spanner_` when loaded by `LlmAgent`).

## Prerequisites

Install the optional `@google-cloud/spanner` peer dependency:

```bash
npm install @google-cloud/spanner
```

Configure your Google Cloud project and OAuth2 client credentials:

```bash
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_OAUTH_CLIENT_ID="your-oauth-client-id"
export GOOGLE_OAUTH_CLIENT_SECRET="your-oauth-client-secret"
```

## Sample Inputs

- `List the tables in instance my-instance and database my-database.`
- `Show the schema and indexes for table Singers in instance my-instance and database my-database.`

## Running the Sample

Build the workspace, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/spanner/agent.ts
```

To open the agent in the ADK web UI, start the web server on `samples/integrations` and select `spanner`:

```bash
adk web samples/integrations
```

Inside this repository, without the global `adk` command installed, run the CLI from the build output:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/integrations
```

Type-check the samples against the built packages:

```bash
npm run build
npm run ts:check:samples
```

## Related Guides

- [Spanner toolset](../../../docs/guides/integrations/spanner/index.md) - `SpannerToolset`, `SpannerCredentialsConfig`, `SpannerToolSettings`, `SpannerCapabilities`, and `getSpannerClient`.
- [Tools](../../../docs/guides/tools/index.md) - `BaseTool`, `GoogleTool`, and `BaseToolset`.
