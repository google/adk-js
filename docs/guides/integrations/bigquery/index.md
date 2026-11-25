# BigQuery toolset (`BigQueryToolset`, `GoogleTool`, `BigQueryCredentialsConfig`, `BigQueryToolConfig`)

`BigQueryToolset`, `BigQueryCredentialsConfig`, and `BigQueryToolConfig` in `@google/adk-integrations`, together with `GoogleTool` in `@google/adk`, equip an ADK `LlmAgent` with first-party tools for inspecting Google Cloud BigQuery datasets and tables, executing SQL queries, and asking natural-language data insights questions.

## Introduction

The BigQuery integration provides six built-in tools wrapped in `GoogleTool` (from `@google/adk`):

- `list_dataset_ids` (`listDatasetIds`): lists dataset IDs in a Google Cloud project.
- `get_dataset_info` (`getDatasetInfo`): retrieves metadata for a dataset.
- `list_table_ids` (`listTableIds`): lists table IDs in a dataset.
- `get_table_info` (`getTableInfo`): retrieves schema and metadata for a table.
- `execute_sql` (`executeSql`): executes a BigQuery or BigQuery ML SQL query and returns `{status: 'SUCCESS', rows}` with up to `maxQueryResultRows` rows (default `50`), setting `result_is_likely_truncated: true` when `maxQueryResultRows` rows are returned. In default read-only mode (`WriteMode.BLOCKED`), `execute_sql` runs a dry-run check before query execution to verify that the query is a SELECT statement; configure `WriteMode.PROTECTED` in `BigQueryToolConfig` to permit session-scoped temporary table and model writes in the anonymous dataset of a BigQuery session, or `WriteMode.ALLOWED` to allow all write operations (DML, DDL).
- `ask_data_insights` (`askDataInsights`): answers natural-language questions about structured data in BigQuery tables through the Gemini Data Analytics conversational API, returning `{status: 'SUCCESS', response}` with a sequential log of generated SQL, retrieved data (formatted up to `maxQueryResultRows` rows), and the final plain-text answer.

`BigQueryCredentialsConfig` extends `BaseGoogleCredentialsConfig` (from `@google/adk`) with `tokenCacheKey` set to `BIGQUERY_TOKEN_CACHE_KEY` (`'bigquery_token_cache'`) and `scopes` defaulting to `BIGQUERY_SCOPES`. It configures authentication using pre-existing credentials (either a `GoogleOAuthCredentials` object or a `GoogleAuthClient` such as a `google-auth-library` `JWT`, `OAuth2Client`, or `GoogleAuth` client), an external access token in `toolContext.state`, or a non-empty OAuth2 client ID and client secret pair. Credential resolution, caching, and token refresh are handled by `GoogleCredentialsManager` from `@google/adk`.

`BigQueryToolConfig` configures tool settings, such as `WriteMode` (`WriteMode.BLOCKED`, `WriteMode.PROTECTED`, `WriteMode.ALLOWED`) and `maxQueryResultRows` (default `50`), passed via `GoogleTool`'s `toolSettings` option (`settings` in `execute` callbacks, `ExecuteSqlArgs`, and `AskDataInsightsArgs`).

> **Deprecations:** `BigQueryTool`, `isBigQueryTool`, `BigQueryOAuthCredentials`, `BigQueryOAuthCredentialsOptions`, `BigQueryAuthClient`, `isBigQueryAuthClient`, `BigQueryCredentials`, and the `config` field on `ExecuteSqlArgs` and `AskDataInsightsArgs` remain exported as `@deprecated` backward-compatible shims. New code should use `GoogleTool`, `GoogleOAuthCredentialsImpl`, `GoogleAuthClient`, `GoogleCredentials`, `isGoogleTool`, `isGoogleAuthClient`, and `settings` instead.

## Installation and environment setup

Install `@google/adk-integrations` along with `@google/adk` and the optional `@google-cloud/bigquery` peer dependency:

```bash
npm install @google/adk @google/adk-integrations @google-cloud/bigquery
```

## Get started

### Equipping an agent with `BigQueryToolset`

Create a `BigQueryCredentialsConfig`, optionally configure `BigQueryToolConfig`, and pass a `BigQueryToolset` to `LlmAgent`:

```ts
import {LlmAgent} from '@google/adk';
import {
  BigQueryCredentialsConfig,
  BigQueryToolConfig,
  BigQueryToolset,
  WriteMode,
} from '@google/adk-integrations';

const credentialsConfig = new BigQueryCredentialsConfig({
  clientId: process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? 'demo-client-id',
  clientSecret:
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? 'demo-client-secret',
});

const toolConfig = new BigQueryToolConfig({
  writeMode: WriteMode.BLOCKED,
  maxQueryResultRows: 50,
});

export const bigQueryToolset = new BigQueryToolset({
  credentialsConfig,
  toolConfig,
  toolFilter: [
    'list_dataset_ids',
    'get_dataset_info',
    'list_table_ids',
    'get_table_info',
    'execute_sql',
    'ask_data_insights',
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

| Option                   | Type                | Default           | Description                                                                                                                                                                                                                                                                                                   |
| :----------------------- | :------------------ | :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credentials`            | `GoogleCredentials` | `undefined`       | Pre-existing credentials (`GoogleOAuthCredentials` or `GoogleAuthClient`, such as a `google-auth-library` client) used for all requests. Mutually exclusive with `externalAccessTokenKey`, `clientId`, `clientSecret`, and non-empty `scopes`.                                                                |
| `externalAccessTokenKey` | `string`            | `undefined`       | Non-empty key in `toolContext.state` holding an external OAuth2 access token. Mutually exclusive with `credentials`, `clientId`, `clientSecret`, and non-empty `scopes`.                                                                                                                                      |
| `clientId`               | `string`            | `undefined`       | Non-empty OAuth2 client ID for interactive user authorization. Required with `clientSecret` when `credentials` and `externalAccessTokenKey` are omitted.                                                                                                                                                      |
| `clientSecret`           | `string`            | `undefined`       | Non-empty OAuth2 client secret for interactive user authorization.                                                                                                                                                                                                                                            |
| `scopes`                 | `readonly string[]` | `BIGQUERY_SCOPES` | OAuth2 scopes requested during authorization. Defaults to `['https://www.googleapis.com/auth/bigquery', 'https://www.googleapis.com/auth/dataplex.read-write']` when omitted or empty. For BigQuery-only access, pass the exported `BIGQUERY_DEFAULT_SCOPE` (`['https://www.googleapis.com/auth/bigquery']`). |

### `BigQueryToolConfigOptions`

| Option               | Type        | Default             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| :------------------- | :---------- | :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writeMode`          | `WriteMode` | `WriteMode.BLOCKED` | Write mode controlling statement permissions for `execute_sql`. `WriteMode.BLOCKED` enforces read-only execution (SELECT statements only) via a dry-run check. `WriteMode.PROTECTED` creates a BigQuery session per ADK session and permits only SELECT statements or writes in that session's anonymous dataset (such as `CREATE TEMP TABLE` and `CREATE TEMP MODEL`), rejecting permanent-dataset or undestined writes. `WriteMode.ALLOWED` permits all DDL and DML writes and includes write examples in the tool description. |
| `maxQueryResultRows` | `number`    | `50`                | Maximum number of rows returned by `execute_sql` and formatted in `ask_data_insights` data tables. Must be a positive integer.                                                                                                                                                                                                                                                                                                                                                                                                    |

### `BigQueryToolsetOptions`

| Option              | Type                                              | Default                    | Description                                                                                                                           |
| :------------------ | :------------------------------------------------ | :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| `toolFilter`        | `ToolPredicate \| string[]`                       | `[]`                       | Selects which tools to expose. When omitted or empty, all six tools are exposed. Unknown tool names are skipped.                      |
| `credentialsConfig` | `BigQueryCredentialsConfig`                       | `undefined`                | Credentials configuration shared across all `GoogleTool` instances in the toolset.                                                    |
| `toolConfig`        | `BigQueryToolConfig \| BigQueryToolConfigOptions` | `new BigQueryToolConfig()` | Tool settings (such as write mode and `maxQueryResultRows`) shared across all tools in the toolset via `GoogleTool`'s `toolSettings`. |

### `GoogleToolOptions` for custom BigQuery tools

Use `GoogleTool` from `@google/adk` with `BigQueryCredentialsConfig` and `BigQueryToolConfig` (passed as `toolSettings`) when building custom BigQuery tools. See [Tools](../../tools/index.md) for the full `GoogleToolOptions` reference.

```ts
import {GoogleTool} from '@google/adk';
import {
  BigQueryCredentialsConfig,
  BigQueryToolConfig,
  WriteMode,
} from '@google/adk-integrations';
import {z} from 'zod';

const credentialsConfig = new BigQueryCredentialsConfig({
  externalAccessTokenKey: 'bigquery_access_token',
});

const toolSettings = new BigQueryToolConfig({
  writeMode: WriteMode.BLOCKED,
  maxQueryResultRows: 50,
});

export const tableIdTool = new GoogleTool({
  name: 'format_table_id',
  description: 'Formats a fully-qualified BigQuery table identifier.',
  parameters: z.object({
    projectId: z.string(),
    datasetId: z.string(),
    tableId: z.string(),
  }),
  credentialsConfig,
  toolSettings,
  execute: async ({projectId, datasetId, tableId, credentials, settings}) => ({
    fullTableId: `${projectId}.${datasetId}.${tableId}`,
    authenticated: credentials !== undefined,
    maxRows: settings?.maxQueryResultRows,
  }),
});
```

> **Legacy `BigQueryTool`:** Existing code using `new BigQueryTool({ ..., toolConfig })` continues to work. `BigQueryTool` extends `GoogleTool`, forwards both `config` and `settings` to `execute`, and omits `'credentials'`, `'config'`, and `'settings'` from declarations and runtime arguments.

### Helper functions

- `executeSql(args, toolContext?)`: executes a SQL query using `args.settings` (falling back to deprecated `args.config` when `settings` is omitted). When both are passed, `settings` takes precedence.
- `askDataInsights(args)`: queries the Gemini Data Analytics API using `args.settings` (falling back to deprecated `args.config` when `settings` is omitted). When both are passed, `settings` takes precedence.
- `getExecuteSql(settings?)`: returns a configured `execute_sql` tool function respecting the given `BigQueryToolConfig` or `BigQueryToolConfigOptions`. Bound `settings` take precedence over call-time `args.settings` and deprecated `args.config`.
- `getExecuteSqlDescription(settings?)`: returns the model-facing description for `execute_sql`, reflecting `maxQueryResultRows` and including temporary table and model examples when `WriteMode.PROTECTED` is configured, or full write and BigQuery ML examples when `WriteMode.ALLOWED` is configured.
- `isBigQueryToolConfig(obj)`: type guard verifying whether an object is a `BigQueryToolConfig` instance.

## How it works

1. **Key casing**: TypeScript classes, methods, and client options (`BigQueryToolset`, `GoogleTool`, `BigQueryCredentialsConfig`, `BaseGoogleCredentialsConfig`, `BigQueryToolConfig`, `getBigQueryClient`, `BigQueryQueryOptions`, `BigQueryConnectionProperty`, `BigQueryDryRunResult`) use `camelCase`. Model-facing tool parameters and result keys (`project_id`, `dataset_id`, `table_id`, `query`, `user_query_with_context`, `table_references`, `error_details`, `result_is_likely_truncated`) use `snake_case` to match `@google/adk`'s built-in tools and keep cross-language tool schemas and traces consistent.
2. **Declaration filtering**: `GoogleTool._getDeclaration()` strips `credentials` and `settings` from declared `properties` and `required` (and deprecated `BigQueryTool` also strips `config`) so the model only sees user-facing parameters (`project_id`, `dataset_id`, `table_id`, `query`, `user_query_with_context`, `table_references`). When `GoogleTool` invokes `executeSql`, `getExecuteSql()`, or `askDataInsights` with `settings: undefined` alongside `credentials` (such as when `toolSettings` is omitted on a raw `Schema`-backed `GoogleTool`), any unstripped `config` argument is ignored.
3. **Credential resolution and caching**: On `runAsync`, after argument validation and any `requireConfirmation` gate, `GoogleTool` resolves credentials through `GoogleCredentialsManager` from `externalAccessTokenKey`, session state at `BIGQUERY_TOKEN_CACHE_KEY` (`'bigquery_token_cache'`) with a 60-second expiry leeway, pre-existing `credentialsConfig.credentials`, token refresh, or an interactive OAuth2 authorization code flow via `toolContext.requestCredential`. Non-`GoogleOAuthRefreshError` errors during OAuth token refresh propagate rather than starting a new OAuth flow.
4. **Client authentication**: `getBigQueryClient` passes `GoogleAuthClient` credentials (such as `google-auth-library` `JWT`, `OAuth2Client`, or `GoogleAuth` instances) directly through the SDK's `authClient` option, or sends a resolved access `token` as a bearer-token `authClient`. If `credentials` is configured without a token or `getRequestHeaders`, client creation throws rather than falling back to ambient credentials; when `credentials` is omitted, `@google-cloud/bigquery` uses Application Default Credentials. When `projectId` is omitted or empty, the client uses `GOOGLE_CLOUD_PROJECT`.
5. **Error handling**: Unhandled exceptions during credential resolution, tool execution, or BigQuery API calls are caught by `GoogleTool` (or the standalone tool helpers) and returned as `{status: 'ERROR', error_details: string}`.
6. **Write mode and query verification**: When `execute_sql` runs with `WriteMode.BLOCKED` (the default), `BigQueryClient.dryRun` validates that the statement type is `SELECT`. Non-SELECT queries return `{status: 'ERROR', error_details: 'Read-only mode only supports SELECT statements.'}`. When configured with `WriteMode.PROTECTED`, `execute_sql` creates and reuses a BigQuery session per ADK session via `createSession: true` and `connectionProperties: [{key: 'session_id', value: sessionId}]`, dry-runs each query with the session connection properties, and rejects non-SELECT statements unless the dry-run destination dataset matches the session's anonymous dataset. When configured with `WriteMode.ALLOWED`, the dry-run statement-type check is bypassed, and write query examples are dynamically appended to the tool declaration description.

## Related guides

- [BigQuery Sample](../../../../samples/integrations/bigquery/README.md) - Runnable sample demonstrating `BigQueryToolset`, `GoogleTool`, `BigQueryCredentialsConfig`, and `BigQueryToolConfig`.
- [Tools](../../tools/index.md) - `BaseTool`, `FunctionTool`, `GoogleTool`, `BaseGoogleCredentialsConfig`, `GoogleCredentialsManager`, and `BaseToolset`.
- [Auth](../../auth/index.md) - `AuthConfig`, `AuthCredential`, and OAuth2 credential flows.
