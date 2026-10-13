# Google API tool

`GoogleApiToolSet` converts a Google API Discovery document into one `GoogleApiTool` per REST method and configures every tool with Google OpenID Connect authentication. Pre-configured toolsets for Calendar, BigQuery, Gmail, YouTube, Slides, Sheets, and Docs are exported directly from `@google/adk`.

- [OpenAPI tool](../openapi_tool/index.md) - Building a toolset directly from an OpenAPI v3 specification for any HTTP service.

## Introduction

Google APIs publish Discovery documents rather than OpenAPI v3 specifications. `GoogleApiToOpenApiConverter` fetches a Google Discovery REST document and translates its metadata, schemas, resources, methods, and OAuth 2.0 scopes into an OpenAPI v3.0.0 document. `GoogleApiToolSet` feeds that converted specification into `OpenAPIToolset`, attaches Google OpenID Connect endpoints, and wraps each resulting `RestApiTool` in a `GoogleApiTool` so you can configure OAuth 2.0 client credentials across the entire service in one call.

The subsystem exposes four main pieces and seven pre-configured toolset instances:

| Export                                                                                                                  | Purpose                                                                                                                                                |
| :---------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GoogleApiToolSet`                                                                                                      | Loads a Google API specification, filters the operations exposed to an agent, and configures OAuth 2.0 client credentials across all tools in the set. |
| `GoogleApiTool`                                                                                                         | Wraps a single `RestApiTool` and adds `configureAuth(clientId, clientSecret)` to set an OpenID Connect credential.                                     |
| `GoogleApiToOpenApiConverter`                                                                                           | Fetches a Google Discovery REST specification by API name and version and converts it into an `OpenAPIV3.Document`.                                    |
| `calendarToolSet`, `bigqueryToolSet`, `gmailToolSet`, `youtubeToolSet`, `slidesToolSet`, `sheetsToolSet`, `docsToolSet` | Pre-configured `GoogleApiToolSet` instances that defer network discovery until `getTools()` or `getTool()` runs.                                       |

All classes in this subsystem carry the `@experimental` decorator and log a one-time warning when instantiated or called.

## Get started

The following example configures OAuth 2.0 client credentials on the pre-built `calendarToolSet` and hands it to an `LlmAgent`.

```ts
import {calendarToolSet, LlmAgent} from '@google/adk';

calendarToolSet.configureAuth(
  process.env.GOOGLE_CLIENT_ID ?? 'demo-client-id',
  process.env.GOOGLE_CLIENT_SECRET ?? 'demo-client-secret',
);

export const rootAgent = new LlmAgent({
  name: 'calendar_agent',
  model: 'gemini-flash-latest',
  description: 'Reads calendar metadata and lists upcoming events.',
  instruction:
    'Use calendar_calendars_get and calendar_events_list to answer questions about the user calendar.',
  tools: [calendarToolSet],
});
```

## How it works

When an agent resolves tools from a `GoogleApiToolSet`, three stages run in sequence.

### 1. Discovery conversion

`GoogleApiToOpenApiConverter` fetches the Discovery document from `https://www.googleapis.com/discovery/v1/apis/{apiName}/{apiVersion}/rest` when `googleApiSpec` has not already been populated. Calling `convert()` translates each section of the Discovery document to produce an `OpenAPIV3.Document`:

- **Info and external docs**: copies `title`, `description`, `version`, and `documentationLink` into `info` and `externalDocs`.
- **Servers**: joins `rootUrl` and `servicePath`, strips any trailing slash, and writes a single entry in `servers`.
- **Security schemes**: maps `auth.oauth2.scopes` into an `authorizationCode` flow under `components.securitySchemes.oauth2` and adds a query-parameter `apiKey` scheme under `components.securitySchemes.apiKey`.
- **Schemas**: recursively translates object properties, required property flags, arrays, `any` schemas, and `$ref` targets into `components.schemas`.
- **Resources and methods**: walks nested resource trees and top-level methods, extracts `{param}` and `{+param}` placeholders (including custom-verb segments like `{documentId}:batchUpdate`), normalizes `{+param}` to `{param}` in the OpenAPI path, and builds operations using each parameter's declared `location`.

### 2. OpenID Connect toolset creation

`GoogleApiToolSet.loadToolSet(apiName, apiVersion)` runs the converter, selects the first OAuth 2.0 scope declared in the converted document, and passes the document and scope to `GoogleApiToolSet.loadToolSetWithOidcAuth`. That method constructs an `OpenAPIToolset` whose `authScheme` is an `OpenIdConnectWithConfig` pointing at Google's authorization, token, userinfo, and revocation endpoints, and wraps every parsed `RestApiTool` in a `GoogleApiTool`. Each Discovery `id` is normalized to `snake_case` by `OpenAPIToolset`, so `calendar.calendars.get` becomes the tool name `calendar_calendars_get`.

### 3. Lazy loading and credential propagation

The pre-configured toolsets such as `calendarToolSet` and `bigqueryToolSet` are constructed with `{apiName, apiVersion}` options and no initial tools, so importing `@google/adk` performs no network I/O and logs the experimental notice only when `getTools()`, `getTool()`, or `configureAuth()` is called. Concurrent calls to `getTools()` or `getTool()` share the same in-flight loading promise. Calling `configureAuth(clientId, clientSecret)` before the first `getTools()` or `getTool()` call stores the credentials on the toolset and applies them as soon as the tools are loaded. Calling `configureAuth` after loading updates every `GoogleApiTool` immediately by passing an `AuthCredential` with `authType: AuthCredentialTypes.OPEN_ID_CONNECT` and `oauth2: {clientId, clientSecret}` to `restApiTool.configureAuthCredential`.

## Configuration options

### GoogleApiToolSetOptions

The second parameter of `new GoogleApiToolSet(tools, options)` accepts a `GoogleApiToolSetOptions` object.

| Option       | Type                        | Default     | Description                                                                                                        |
| :----------- | :-------------------------- | :---------- | :----------------------------------------------------------------------------------------------------------------- |
| `apiName`    | `string`                    | `undefined` | Google Discovery API identifier, such as `'calendar'` or `'gmail'`, used for lazy loading when `tools` is omitted. |
| `apiVersion` | `string`                    | `undefined` | Google Discovery API version string, such as `'v3'` or `'v1'`, used alongside `apiName`.                           |
| `toolFilter` | `ToolPredicate \| string[]` | `[]`        | Selects which tools `getTools()` exposes to the agent. An empty array exposes every tool.                          |

`apiName` and `apiVersion` work together. When `tools` is `undefined` and both `apiName` and `apiVersion` are set, the first call to `getTools()` or `getTool()` invokes `GoogleApiToolSet.loadToolSet(apiName, apiVersion)` and caches the resulting tools on the instance.

`toolFilter` accepts either an array of tool names or a `(tool, readonlyContext) => boolean` predicate function. Construct a dedicated `GoogleApiToolSet` instance with `{apiName, apiVersion, toolFilter}` when narrowing an API to the specific methods an agent needs.

### LoadToolSetWithOidcAuthOptions

`GoogleApiToolSet.loadToolSetWithOidcAuth(options)` accepts a `LoadToolSetWithOidcAuthOptions` object and returns an `OpenAPIToolset`.

| Option      | Type                 | Default         | Description                                                                      |
| :---------- | :------------------- | :-------------- | :------------------------------------------------------------------------------- |
| `specFile`  | `string`             | `undefined`     | Path to a YAML or JSON OpenAPI specification file to read from disk.             |
| `specDict`  | `OpenAPIV3.Document` | `undefined`     | Pre-parsed OpenAPI v3 document. Used directly when provided.                     |
| `scopes`    | `string[]`           | `undefined`     | OAuth 2.0 scope URLs attached to the generated `OpenIdConnectWithConfig` scheme. |
| `callerDir` | `string`             | `process.cwd()` | Base directory used to resolve a relative `specFile` path.                       |

Provide either `specDict` or `specFile`. When `specFile` is relative, `loadToolSetWithOidcAuth` joins it with `callerDir` before reading the file with `fs.readFileSync`.

## Advanced applications

### Loading any Google Discovery API on demand

For a Google API that is not among the seven pre-configured toolsets, call `GoogleApiToolSet.loadToolSet` directly with its Discovery name and version, or construct a lazy `GoogleApiToolSet` with `apiName` and `apiVersion`.

```ts
import {GoogleApiToolSet} from '@google/adk';

const driveToolSet = new GoogleApiToolSet(undefined, {
  apiName: 'drive',
  apiVersion: 'v3',
  toolFilter: ['drive_files_list', 'drive_files_get'],
});
driveToolSet.configureAuth(clientId, clientSecret);
```

### Converting and saving an OpenAPI specification

When you want to inspect the converted OpenAPI v3 document or save it to disk for offline use with `OpenAPIToolset`, run `GoogleApiToOpenApiConverter` directly.

```ts
import {GoogleApiToOpenApiConverter} from '@google/adk';

const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
const openapiSpec = await converter.convert();
converter.saveOpenapiSpec('./calendar_v3_openapi.json');
```

### Selecting a single tool from a toolset

`getTool(toolName)` resolves to the matching `GoogleApiTool` or `undefined` without applying `toolFilter`, so you can extract a single operation for a specialized agent.

```ts
import {calendarToolSet} from '@google/adk';

const getCalendarTool = await calendarToolSet.getTool('calendar_calendars_get');
if (getCalendarTool) {
  getCalendarTool.configureAuth(clientId, clientSecret);
}
```

## Limitations

- **Node.js entry point only.** `google_api_tool` imports `node:fs` and `node:path` and is exported from the Node entry point of `@google/adk`, not from the browser bundle `@google/adk/web`.
- **Single scope selection in `loadToolSet`.** `GoogleApiToolSet.loadToolSet` attaches only the first scope key from `components.securitySchemes.oauth2.flows.authorizationCode.scopes` to the `OpenIdConnectWithConfig` scheme. When an operation requires a different scope, build the toolset with `GoogleApiToolSet.loadToolSetWithOidcAuth` and pass the desired `scopes` array explicitly.
- **Discovery path parameter types.** The converter emits `{type: 'string'}` for all path parameters extracted from `{param}` or `{+param}` placeholders, and skips those parameter names when iterating `methodData.parameters`.

## Related samples

- [samples/tools/google_api_tool/](../../../../samples/tools/google_api_tool/README.md) - Converts a Google Calendar Discovery specification into tools, configures OpenID Connect credentials, and executes a tool call through an agent.
- [Tool samples](../../../../samples/tools/README.md) - Overview of all tool samples and how to run and type-check them.

## Related guides

- [OpenAPI tool](../openapi_tool/index.md) - Parsing OpenAPI v3 specifications into `RestApiTool` instances with `OpenAPIToolset`.
- [Auth](../../auth/index.md) - `AuthCredential`, `OpenIdConnectWithConfig`, and the credential exchange pipeline.
