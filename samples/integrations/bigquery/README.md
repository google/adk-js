# BigQuery Toolset Sample (`BigQueryToolset`)

This sample demonstrates how to equip an `LlmAgent` with `BigQueryToolset`, `BigQueryTool`, and `BigQueryCredentialsConfig` from `@google/adk-integrations`.

## Overview

`bigquery_data_assistant` is an `LlmAgent` configured with:

1. `BigQueryCredentialsConfig` for OAuth2 client credentials and default BigQuery scopes.
2. `BigQueryToolset` exposing `list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`, and `execute_sql`.
3. A custom `BigQueryTool` (`summarize_bigquery_target`) that receives resolved credentials while stripping `credentials` from the model's `FunctionDeclaration`.

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

- [BigQuery toolset](../../../docs/guides/integrations/bigquery/index.md) - `BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`, and `getBigQueryClient`.
- [Tools](../../../docs/guides/tools/index.md) - `BaseTool`, `FunctionTool`, and `BaseToolset`.
