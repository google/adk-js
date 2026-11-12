# BigQuery toolset (`BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`, `BigQueryToolConfig`)

`BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`, and `BigQueryToolConfig` in `@google/adk-integrations` equip an ADK `LlmAgent` with first-party tools for inspecting Google Cloud BigQuery datasets and tables and executing SQL queries.

## Introduction

The BigQuery integration provides five built-in tools wrapped in `BigQueryTool`:

- `list_dataset_ids` (`listDatasetIds`): lists dataset IDs in a Google Cloud project.
- `get_dataset_info` (`getDatasetInfo`): retrieves metadata for a dataset.
- `list_table_ids` (`listTableIds`): lists table IDs in a dataset.
- `get_table_info` (`getTableInfo`): retrieves schema and metadata for a table.
- `execute_sql` (`executeSql`): executes a SQL query and returns `{status: 'SUCCESS', rows}` with up to 50 rows, setting `result_is_likely_truncated: true` when 50 rows are returned. In default read-only mode (`WriteMode.BLOCKED`), `execute_sql` runs a dry-run check before query execution to verify that the query is a SELECT statement; configure `WriteMode.ALLOWED` in `BigQueryToolConfig` to allow write operations (DML, DDL).

`BigQueryCredentialsConfig` configures authentication using pre-existing credentials (either a `GoogleOAuthCredentials` object or a `BigQueryAuthClient` such as a `google-auth-library` `JWT`, `OAuth2Client`, or `GoogleAuth` client), an external access token in `toolContext.state`, or an OAuth2 client ID and client secret pair.

`BigQueryToolConfig` configures tool execution options, such as `WriteMode` (`WriteMode.BLOCKED`, `WriteMode.ALLOWED`).

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

| Option                   | Type                  | Default           | Description                                                                                                                                                                                                                                                                                                   |
| :----------------------- | :-------------------- | :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credentials`            | `BigQueryCredentials` | `undefined`       | Pre-existing credentials (`GoogleOAuthCredentials` or `BigQueryAuthClient`, such as a `google-auth-library` client) used for all requests. Mutually exclusive with `externalAccessTokenKey`, `clientId`, `clientSecret`, and `scopes`.                                                                        |
| `externalAccessTokenKey` | `string`              | `undefined`       | Key in `toolContext.state` holding an external OAuth2 access token. Mutually exclusive with `credentials`, `clientId`, `clientSecret`, and `scopes`.                                                                                                                                                          |
| `clientId`               | `string`              | `undefined`       | OAuth2 client ID for interactive user authorization. Required with `clientSecret` when `credentials` and `externalAccessTokenKey` are omitted.                                                                                                                                                                |
| `clientSecret`           | `string`              | `undefined`       | OAuth2 client secret for interactive user authorization.                                                                                                                                                                                                                                                      |
| `scopes`                 | `string[]`            | `BIGQUERY_SCOPES` | OAuth2 scopes requested during authorization. Defaults to `['https://www.googleapis.com/auth/bigquery', 'https://www.googleapis.com/auth/dataplex.read-write']` when omitted or empty. For BigQuery-only access, pass the exported `BIGQUERY_DEFAULT_SCOPE` (`['https://www.googleapis.com/auth/bigquery']`). |

### `BigQueryToolConfigOptions`

| Option      | Type        | Default              | Description                                                                                                                                                                                                                                                                                                                       |
| :---------- | :---------- | :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writeMode` | `WriteMode` | `WriteMode.BLOCKED`  | Write mode controlling statement permissions for `execute_sql`. `WriteMode.BLOCKED` enforces read-only execution (SELECT statements only) via a dry-run check. `WriteMode.ALLOWED` permits DDL and DML writes and includes write examples in the tool description. |

### `BigQueryToolsetOptions`

| Option              | Type                                              | Default                     | Description                                                                                                                                |
| :------------------ | :------------------------------------------------ | :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `toolFilter`        | `ToolPredicate \| string[]`                       | `[]`                        | Selects which tools to expose. When omitted or empty, all five tools are exposed. Unknown tool names are skipped.                          |
| `credentialsConfig` | `BigQueryCredentialsConfig`                       | `undefined`                 | Credentials configuration shared across all tools in the toolset.                                                                          |
| `toolConfig`        | `BigQueryToolConfig \| BigQueryToolConfigOptions` | `new BigQueryToolConfig()`  | Tool configuration (such as write mode) shared across all tools in the toolset. Defaults to `WriteMode.BLOCKED`.                            |

### `BigQueryToolOptions`

`BigQueryTool` extends `FunctionTool` and takes the same core options.

| Option                | Type                                              | Default        | Description                                                                                                                                 |
| :-------------------- | :------------------------------------------------ | :------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| `execute`             | `BigQueryToolExecuteFunction`                     | Required       | Function implementing the tool logic. Receives the validated arguments plus `credentials` and `config`, and `toolContext`.                   |
| `name`                | `string`                                          | `execute.name` | Tool name exposed to the model. Required when `execute` is anonymous.                                                                       |
| `description`         | `string`                                          | Required       | Tool description exposed to the model.                                                                                                      |
| `parameters`          | `ToolInputParameters`                             | `undefined`    | Zod object schema or `@google/genai` `Schema` for tool arguments. Do not declare `credentials` or `config`.                                 |
| `credentialsConfig`   | `BigQueryCredentialsConfig`                       | `undefined`    | Credentials configuration used by the tool. When omitted, `credentials` is `undefined` and the client uses Application Default Credentials. |
| `toolConfig`          | `BigQueryToolConfig \| BigQueryToolConfigOptions` | `undefined`    | Configuration for BigQuery tools (such as write mode). Injected into `execute` and omitted from model-facing declarations.                   |
| `isLongRunning`       | `boolean`                                         | `false`        | Whether the tool is a long-running operation.                                                                                               |
| `requireConfirmation` | `RequireConfirmation`                             | `false`        | Asks the user to approve the call before credentials are resolved and `execute` runs.                                                       |

### Custom BigQuery tools

```ts
import {
  BigQueryCredentialsConfig,
  BigQueryTool,
} from '@google/adk-integrations';
import {z} from 'zod';

const credentialsConfig = new BigQueryCredentialsConfig({
  externalAccessTokenKey: 'bigquery_access_token',
});

export const tableIdTool = new BigQueryTool({
  name: 'format_table_id',
  description: 'Formats a fully-qualified BigQuery table identifier.',
  parameters: z.object({
    projectId: z.string(),
    datasetId: z.string(),
    tableId: z.string(),
  }),
  credentialsConfig,
  execute: async ({projectId, datasetId, tableId, credentials}) => ({
    fullTableId: `${projectId}.${datasetId}.${tableId}`,
    authenticated: credentials !== undefined,
  }),
});
```

### Helper functions

- `getExecuteSql(config?)`: returns a configured `execute_sql` tool function respecting the given `BigQueryToolConfig` or `BigQueryToolConfigOptions`. Config values bound to the executor take precedence over call-time configuration.
- `getExecuteSqlDescription(config?)`: returns the model-facing description for `execute_sql`, including write query examples when `WriteMode.ALLOWED` is configured.
- `isBigQueryToolConfig(obj)`: type guard verifying whether an object is a `BigQueryToolConfig` instance.

## How it works

1. **Key casing**: TypeScript classes, methods, and client options (`BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`, `BigQueryToolConfig`, `getBigQueryClient`) use `camelCase`. Model-facing tool parameters and result keys (`project_id`, `dataset_id`, `table_id`, `query`, `error_details`, `result_is_likely_truncated`) use `snake_case` to match `@google/adk`'s built-in tools and keep cross-language tool schemas and traces consistent.
2. **Declaration filtering**: `BigQueryTool._getDeclaration()` strips `credentials` and `config` from declared `properties` and `required` so the model only sees user-facing parameters (`project_id`, `dataset_id`, `table_id`, `query`).
3. **Credential resolution and caching**: On `runAsync`, after argument validation and any `requireConfirmation` gate, `BigQueryTool` resolves credentials from `externalAccessTokenKey`, session state at `BIGQUERY_TOKEN_CACHE_KEY` (`'bigquery_token_cache'`) with a 60-second expiry leeway, pre-existing `credentialsConfig.credentials`, token refresh, or an interactive OAuth2 authorization code flow via `toolContext.requestCredential`.
4. **Client authentication**: `getBigQueryClient` passes `BigQueryAuthClient` credentials (such as `google-auth-library` `JWT`, `OAuth2Client`, or `GoogleAuth` instances) directly through the SDK's `authClient` option, or sends a resolved access `token` as a bearer-token `authClient`. If `credentials` is configured without a token or `getRequestHeaders`, client creation throws rather than falling back to ambient credentials; when `credentials` is omitted, `@google-cloud/bigquery` uses Application Default Credentials. When `projectId` is omitted or empty, the client uses `GOOGLE_CLOUD_PROJECT`.
5. **Error handling**: Unhandled exceptions during tool execution or BigQuery API calls are caught and returned as `{status: 'ERROR', error_details: string}`.
6. **Write mode and query verification**: When `execute_sql` runs with `WriteMode.BLOCKED` (the default), `BigQueryClient.dryRun` validates that the statement type is `SELECT`. Non-SELECT queries return `{status: 'ERROR', error_details: 'Read-only mode only supports SELECT statements.'}`. When configured with `WriteMode.ALLOWED`, the dry-run statement-type check is bypassed, and write query examples are dynamically appended to the tool declaration description.

## Related guides

- [BigQuery Sample](../../../../samples/integrations/bigquery/README.md) - Runnable sample demonstrating `BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`, and `BigQueryToolConfig`.
- [Tools](../../tools/index.md) - `BaseTool`, `FunctionTool`, and `BaseToolset`.
- [Auth](../../auth/index.md) - `AuthConfig`, `AuthCredential`, and OAuth2 credential flows.
