# BigQuery toolset (`BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`)

`BigQueryToolset`, `BigQueryTool`, and `BigQueryCredentialsConfig` in `@google/adk-integrations` equip an ADK `LlmAgent` with first-party tools for inspecting Google Cloud BigQuery datasets and tables and executing SQL queries.

## Introduction

The BigQuery integration provides five built-in tools wrapped in `BigQueryTool`:

- `list_dataset_ids` (`listDatasetIds`): lists dataset IDs in a Google Cloud project.
- `get_dataset_info` (`getDatasetInfo`): retrieves metadata for a dataset.
- `list_table_ids` (`listTableIds`): lists table IDs in a dataset.
- `get_table_info` (`getTableInfo`): retrieves schema and metadata for a table.
- `execute_sql` (`executeSql`): executes a SQL query and returns up to 50 rows, setting `result_is_likely_truncated: true` when 50 rows are returned.

`BigQueryCredentialsConfig` configures authentication using pre-existing credentials, an external access token in `toolContext.state`, or an OAuth2 client ID and client secret pair.

## Installation and environment setup

Install `@google/adk-integrations` along with `@google/adk` and the optional `@google-cloud/bigquery` peer dependency:

```bash
npm install @google/adk @google/adk-integrations @google-cloud/bigquery
```

## Get started

### Equipping an agent with `BigQueryToolset`

Create a `BigQueryCredentialsConfig` and pass a `BigQueryToolset` to `LlmAgent`:

```ts
import {LlmAgent} from '@google/adk';
import {
  BigQueryCredentialsConfig,
  BigQueryToolset,
} from '@google/adk-integrations';

const credentialsConfig = new BigQueryCredentialsConfig({
  clientId: process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? 'demo-client-id',
  clientSecret:
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? 'demo-client-secret',
});

export const bigQueryToolset = new BigQueryToolset({
  credentialsConfig,
  toolFilter: [
    'list_dataset_ids',
    'get_dataset_info',
    'list_table_ids',
    'get_table_info',
    'execute_sql',
  ],
});

export const rootAgent = new LlmAgent({
  name: 'bigquery_analyst',
  model: 'gemini-flash-latest',
  instruction:
    'Inspect BigQuery datasets and tables and run SQL queries to answer user questions.',
  tools: [bigQueryToolset],
});
```

## Configuration options

### `BigQueryCredentialsConfigOptions`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `credentials` | `GoogleOAuthCredentials` | `undefined` | Pre-existing credentials used for all requests. Mutually exclusive with `externalAccessTokenKey`, `clientId`, `clientSecret`, and `scopes`. |
| `externalAccessTokenKey` | `string` | `undefined` | Key in `toolContext.state` holding an external OAuth2 access token. Mutually exclusive with `credentials`, `clientId`, `clientSecret`, and `scopes`. |
| `clientId` | `string` | `undefined` | OAuth2 client ID for interactive user authorization. Required with `clientSecret` when `credentials` and `externalAccessTokenKey` are omitted. |
| `clientSecret` | `string` | `undefined` | OAuth2 client secret for interactive user authorization. |
| `scopes` | `string[]` | `BIGQUERY_SCOPES` | OAuth2 scopes requested during authorization. Defaults to `BIGQUERY_SCOPES` (`['https://www.googleapis.com/auth/bigquery', 'https://www.googleapis.com/auth/dataplex.read-write']`) when omitted or empty. `@google/adk-integrations` also exports `BIGQUERY_DEFAULT_SCOPE` (`['https://www.googleapis.com/auth/bigquery']`) for BigQuery-only scope configuration. |

### `BigQueryToolsetOptions`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `toolFilter` | `ToolPredicate \| string[]` | `undefined` | Selects which tools to expose. When `undefined`, all five tools are exposed; an empty array `[]` exposes zero tools. |
| `credentialsConfig` | `BigQueryCredentialsConfig` | `undefined` | Credentials configuration shared across all tools in the toolset. |

### `BigQueryToolOptions`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `func` | `BigQueryToolCallable` | Required (or `execute`) | Function implementing the tool logic. Receives `{...args, credentials}` and `toolContext`. |
| `execute` | `ToolExecuteFunction` | `undefined` | Alias for `func`. |
| `name` | `string` | Built-in or `func.name` | Tool name exposed to the model. |
| `description` | `string` | Built-in or `''` | Tool description exposed to the model. |
| `parameters` | `ToolInputParameters` | Built-in or `undefined` | Zod object schema or `@google/genai` `Schema` for tool arguments. |
| `credentials` | `BigQueryCredentialsConfig \| null` | `null` | Credentials configuration used by the tool. |
| `credentialsConfig` | `BigQueryCredentialsConfig \| null` | `null` | Alias for `credentials`. |

## How it works

1. **Declaration filtering**: `BigQueryTool._getDeclaration()` strips `credentials` from declared `properties` and `required` so the model only sees user-facing parameters (`project_id`, `dataset_id`, `table_id`, `query`).
2. **Credential resolution and caching**: On `runAsync`, `BigQueryTool` resolves credentials from `externalAccessTokenKey`, session state at `BIGQUERY_TOKEN_CACHE_KEY` (`'bigquery_token_cache'`), pre-existing `credentialsConfig.credentials`, token refresh, or an interactive OAuth2 authorization code flow via `toolContext.requestCredential`.
3. **Error handling**: Unhandled exceptions during tool execution or BigQuery API calls are caught and returned as `{status: 'ERROR', error_details: string}`.

## Related guides

- [BigQuery Sample](../../../../samples/integrations/bigquery/README.md) - Runnable sample demonstrating `BigQueryToolset`, `BigQueryTool`, and `BigQueryCredentialsConfig`.
- [Tools](../../tools/index.md) - `BaseTool`, `FunctionTool`, and `BaseToolset`.
- [Auth](../../auth/index.md) - `AuthConfig`, `AuthCredential`, and OAuth2 credential flows.
