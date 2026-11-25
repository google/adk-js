# Spanner toolset (`SpannerToolset`, `SpannerCredentialsConfig`, `SpannerToolSettings`)

`SpannerToolset`, `SpannerCredentialsConfig`, and `SpannerToolSettings` in `@google/adk-integrations` equip an ADK `LlmAgent` with first-party tools for inspecting Google Cloud Spanner schemas, indexes, and tables and running read-only SQL queries.

## Introduction

The Spanner integration provides six built-in `GoogleTool` instances configured by `SpannerToolset`:

- `list_table_names` (`listTableNames`): lists table names in a Cloud Spanner database across both GoogleSQL and PostgreSQL dialects.
- `get_table_schema` (`getTableSchema`): retrieves column definitions, `KEY_COLUMN_USAGE` constraint entries, and table metadata (`{schema, metadata}`) for a GoogleSQL table.
- `list_table_indexes` (`listTableIndexes`): lists secondary and primary key indexes for a GoogleSQL table.
- `list_table_index_columns` (`listTableIndexColumns`): lists index columns and types for a GoogleSQL table.
- `list_named_schemas` (`listNamedSchemas`): lists user-created named schemas in a GoogleSQL database.
- `execute_sql` (`executeSpannerSql`): executes a read-only SQL query inside a snapshot transaction and returns `{status: 'SUCCESS', rows}` with up to `maxExecutedQueryResultRows` positional rows (default `50`), setting `result_is_likely_truncated: true` when the row cap is reached.

`SpannerCredentialsConfig` extends `BaseGoogleCredentialsConfig` to configure OAuth2 client credentials, an external access token in `toolContext.state`, or pre-existing `GoogleCredentials` (either `GoogleOAuthCredentials` or a `GoogleAuthClient` such as `google-auth-library` `JWT`, `OAuth2Client`, or `GoogleAuth`), caching serialized OAuth2 tokens under `SPANNER_TOKEN_CACHE_KEY` (`'spanner_token_cache'`).

`SpannerToolSettings` configures allowed `SpannerCapabilities` (defaulting to `[SpannerCapabilities.DATA_READ]`) and `maxExecutedQueryResultRows` (defaulting to `50`).

## Installation and environment setup

Install `@google/adk-integrations` along with `@google/adk` and the optional `@google-cloud/spanner` peer dependency:

```bash
npm install @google/adk @google/adk-integrations @google-cloud/spanner
```

## Get started

### Equipping an agent with `SpannerToolset`

Create a `SpannerCredentialsConfig`, optionally configure `SpannerToolSettings`, and pass a `SpannerToolset` to `LlmAgent`:

```ts
import {LlmAgent} from '@google/adk';
import {
  SpannerCapabilities,
  SpannerCredentialsConfig,
  SpannerToolset,
  SpannerToolSettings,
} from '@google/adk-integrations';

const credentialsConfig = new SpannerCredentialsConfig({
  clientId: process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? 'demo-client-id',
  clientSecret:
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? 'demo-client-secret',
});

const spannerToolSettings = new SpannerToolSettings({
  capabilities: [SpannerCapabilities.DATA_READ],
  maxExecutedQueryResultRows: 50,
});

export const spannerToolset = new SpannerToolset({
  credentialsConfig,
  spannerToolSettings,
  toolFilter: [
    'list_table_names',
    'get_table_schema',
    'list_table_indexes',
    'list_table_index_columns',
    'list_named_schemas',
    'execute_sql',
  ],
});

export const rootAgent = new LlmAgent({
  name: 'spannerAnalyst',
  model: 'gemini-flash-latest',
  instruction:
    'Inspect Spanner database schemas and indexes before running read-only SQL queries.',
  tools: [spannerToolset],
});
```

## Configuration options

### `SpannerCredentialsConfigOptions`

| Option                   | Type                | Default                   | Description                                                                                                                                                                                              |
| :----------------------- | :------------------ | :------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credentials`            | `GoogleCredentials` | `undefined`               | Pre-existing `GoogleOAuthCredentials` or `GoogleAuthClient` (`JWT`, `OAuth2Client`, `GoogleAuth`). Mutually exclusive with `externalAccessTokenKey`, `clientId`, `clientSecret`, and non-empty `scopes`. |
| `externalAccessTokenKey` | `string`            | `undefined`               | Non-empty key in `toolContext.state` holding an external OAuth2 access token. Mutually exclusive with `credentials`, `clientId`, `clientSecret`, and non-empty `scopes`.                                 |
| `clientId`               | `string`            | `undefined`               | OAuth2 client ID for interactive authorization. Required with `clientSecret` when `credentials` and `externalAccessTokenKey` are omitted.                                                                |
| `clientSecret`           | `string`            | `undefined`               | OAuth2 client secret for interactive authorization.                                                                                                                                                      |
| `scopes`                 | `readonly string[]` | `SPANNER_DEFAULT_SCOPE`   | OAuth2 scopes requested during authorization. Defaults to `['https://www.googleapis.com/auth/spanner.admin', 'https://www.googleapis.com/auth/spanner.data']` when omitted or empty.                     |
| `tokenCacheKey`          | `string`            | `SPANNER_TOKEN_CACHE_KEY` | Session state key used to cache serialized OAuth2 credentials (`'spanner_token_cache'`).                                                                                                                 |

### `SpannerToolSettingsOptions`

| Option                       | Type                             | Default                           | Description                                                                                                              |
| :--------------------------- | :------------------------------- | :-------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| `capabilities`               | `readonly SpannerCapabilities[]` | `[SpannerCapabilities.DATA_READ]` | Allowed tool capabilities. Omitting `SpannerCapabilities.DATA_READ` disables `execute_sql` while keeping metadata tools. |
| `maxExecutedQueryResultRows` | `number`                         | `50`                              | Maximum number of rows returned by `execute_sql`. Must be a positive integer (`RangeError` otherwise).                   |

### `SpannerToolsetOptions`

| Option                | Type                                                | Default                            | Description                                                                                                                         |
| :-------------------- | :-------------------------------------------------- | :--------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `toolFilter`          | `ToolPredicate \| readonly string[]`                | `[]`                               | Selects which unprefixed tools to expose. Following `BaseToolset`, omitting `toolFilter` or passing `[]` exposes all enabled tools. |
| `toolNamePrefix`      | `string`                                            | `DEFAULT_SPANNER_TOOL_NAME_PREFIX` | Prefix prepended as `${toolNamePrefix}_` by `getToolsWithPrefix()` (`'spanner'` by default).                                        |
| `credentialsConfig`   | `SpannerCredentialsConfig`                          | `undefined`                        | Credentials configuration shared across all tools in the toolset.                                                                   |
| `spannerToolSettings` | `SpannerToolSettings \| SpannerToolSettingsOptions` | `new SpannerToolSettings()`        | Capability and row-limit settings shared across all tools in the toolset.                                                           |

### Helper functions

- `getSpannerClient(options?)`: creates a `SpannerClient` with `SPANNER_USER_AGENT`, `GOOGLE_CLOUD_PROJECT` fallback when `projectId` is omitted or empty, `disableBuiltInMetrics: true` by default, and `authClient` forwarding.
- `getExecuteSpannerSqlDescription(settings?)`: builds the model-facing `execute_sql` description reflecting `maxExecutedQueryResultRows` with singular/plural row wording.
- `resolveMaxExecutedQueryResultRows(value?)`: validates positive integer row limits (`RangeError` on invalid input) and defaults to `50`.
- `isSpannerToolset(obj)`, `isSpannerToolSettings(obj)`, `isSpannerCredentialsConfig(obj)`, `isSpannerClient(obj)`: symbol-based type guards.

## How it works

1. **Tool prefixing**: `SpannerToolset.getTools()` returns unprefixed `GoogleTool` instances (`list_table_names`, `list_table_indexes`, `list_table_index_columns`, `list_named_schemas`, `get_table_schema`, `execute_sql`). Because `SpannerToolset` sets `toolNamePrefix` to `DEFAULT_SPANNER_TOOL_NAME_PREFIX` (`'spanner'`), `LlmAgent` invokes `getToolsWithPrefix()` and registers `spanner_list_table_names`, `spanner_execute_sql`, and the remaining `spanner_*` tools without mutating `getTools()`.
2. **Key casing**: TypeScript classes, options, and client helpers (`SpannerToolset`, `SpannerCredentialsConfig`, `SpannerToolSettings`, `SpannerCapabilities`, `getSpannerClient`, `executeSpannerSql`) use `camelCase`. Model-facing tool parameters and response fields (`project_id`, `instance_id`, `database_id`, `table_name`, `named_schema`, `table_id`, `query`, `error_details`, `result_is_likely_truncated`) use `snake_case` to match `@google/adk`'s built-in tool contracts across languages.
3. **Resource lifecycle**: `SpannerClient.withDatabase` lazily imports `@google-cloud/spanner`, creates an SDK client with `SPANNER_USER_AGENT` and `disableBuiltInMetrics: true` by default, acquires and ends read-only snapshots (`snapshot.end()`), and closes database handles (`database.close()`) before SDK clients (`client.close()`) inside `finally` blocks, logging cleanup failures with `logger.warn` without masking earlier errors.
4. **PostgreSQL dialect behavior**: `list_table_names` inspects the database dialect and queries `INFORMATION_SCHEMA.TABLES` using `@named_schema` (default `''`, filtering `SPANNER_STATE = 'COMMITTED'`) for GoogleSQL and `$1` (default `'public'`) for PostgreSQL. `get_table_schema`, `list_table_indexes`, `list_table_index_columns`, `list_named_schemas`, and `execute_sql` return `{status: 'ERROR', error_details: 'PostgreSQL dialect is not supported.'}` when targeting a PostgreSQL-dialect database.
5. **Non-JSON values and row capping**: `execute_sql` streams rows from a read-only snapshot, stops and destroys the stream after collecting `maxExecutedQueryResultRows` rows (setting `result_is_likely_truncated: true` when the cap is reached), unwraps Spanner `Int`/`Float`/`Struct` values cleanly, and formats non-JSON-serializable values (such as circular objects or `BigInt` values) using Node's `util.inspect`.

## Related guides

- [Spanner Sample](../../../../samples/integrations/spanner/README.md) - Runnable sample demonstrating `SpannerToolset`, `SpannerCredentialsConfig`, and `SpannerToolSettings`.
- [BigQuery toolset](../bigquery/index.md) - First-party BigQuery toolset in `@google/adk-integrations`.
- [Tools](../../tools/index.md) - `BaseTool`, `BaseToolset`, and `GoogleTool`.
- [Auth](../../auth/index.md) - `AuthConfig`, `AuthCredential`, and OAuth2 credential flows.
