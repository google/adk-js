# BigQuery Toolset Sample (`BigQueryToolset`)

This sample demonstrates how to equip an `LlmAgent` with `BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`, and `BigQueryToolConfig` from `@google/adk-integrations`.

## Overview

`bigquery_data_assistant` is an `LlmAgent` configured with:

1. `BigQueryCredentialsConfig` for OAuth2 client credentials and default `BIGQUERY_SCOPES` (BigQuery and Dataplex read-write; `@google/adk-integrations` also exports `BIGQUERY_DEFAULT_SCOPE`, `['https://www.googleapis.com/auth/bigquery']`, for BigQuery-only access).
2. `BigQueryToolConfig` specifying the write permissions for BigQuery tools. By default, or with `WriteMode.BLOCKED`, `execute_sql` enforces read-only mode via a dry-run check before query execution, rejecting statements that are not `SELECT`. Set `writeMode: WriteMode.PROTECTED` to allow temporary table and model writes inside the anonymous dataset of a BigQuery session while rejecting writes to permanent datasets, or `writeMode: WriteMode.ALLOWED` to allow all DML and DDL writes.
3. `BigQueryToolset` exposing `list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`, and `execute_sql`.
4. A custom `BigQueryTool` (`summarize_bigquery_target`) that receives resolved credentials and configuration while stripping internal parameters from the model's `FunctionDeclaration`.

## Prerequisites

Install the optional `@google-cloud/bigquery` peer dependency:

```bash
npm install @google-cloud/bigquery
```

Configure your Google Cloud project and OAuth2 client credentials:

```bash
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_OAUTH_CLIENT_ID="your-oauth-client-id"
export GOOGLE_OAUTH_CLIENT_SECRET="your-oauth-client-secret"
```

To enable session-scoped temporary table or model writes (`WriteMode.PROTECTED`) or unrestricted write queries (`WriteMode.ALLOWED`), configure `BigQueryToolConfig`:

```ts
import {BigQueryToolConfig, WriteMode} from '@google/adk-integrations';

const protectedWriteConfig = new BigQueryToolConfig({
  writeMode: WriteMode.PROTECTED,
});

const writeAllowedConfig = new BigQueryToolConfig({
  writeMode: WriteMode.ALLOWED,
});
```

When write access is not intended, keep the default `WriteMode.BLOCKED` (or configure read-only OAuth2 scopes):

```ts
const readOnlyCredentialsConfig = new BigQueryCredentialsConfig({
  clientId: process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? 'sample-client-id',
  clientSecret:
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? 'sample-client-secret',
  scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
});
```

## Sample Inputs

- `List the datasets in bigquery-public-data.`
- `Show the schema for bigquery-public-data.ml_datasets.penguins.`

## Running the Sample

Build the workspace, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/bigquery/agent.ts
```

To open the agent in the ADK web UI, start the web server on `samples/integrations` and select `bigquery`:

```bash
adk web samples/integrations
```

Inside this repository, without the global `adk` command installed, run the CLI from the build output:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/integrations
```

`samples/` is type-checked against the built package types:

```bash
npm run build
npm run ts:check:samples
```

## Related Guides

- [BigQuery toolset](../../../docs/guides/integrations/bigquery/index.md) - `BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`, `BigQueryToolConfig`, and `getBigQueryClient`.
- [Tools](../../../docs/guides/tools/index.md) - `BaseTool`, `FunctionTool`, and `BaseToolset`.
