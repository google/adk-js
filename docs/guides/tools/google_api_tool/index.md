# Google API tool

`GoogleApiToolset` converts a Google API Discovery document into `GoogleApiTool` instances and configures them with Google OpenID Connect authentication. Pre-configured toolsets for Calendar, BigQuery, Gmail, YouTube, Slides, Sheets, and Docs are exported directly from `@google/adk`.

- [OpenAPI tool](../openapi_tool/index.md) - Building a toolset directly from an OpenAPI v3 specification for any HTTP service.

## Introduction

Google APIs publish Discovery documents rather than OpenAPI v3 specifications. The internal converter translates Discovery documents into an OpenAPI v3.0.0 specification. `GoogleApiToolset` attaches Google OpenID Connect endpoints and wraps each operation in a `GoogleApiTool` so you can configure OAuth 2.0 client credentials across the service.

The subsystem exposes nine toolset and tool classes:

| Export | Purpose |
| :--- | :--- |
| `GoogleApiToolset` | Loads a Google API specification, filters operations exposed to an agent, and configures OAuth 2.0 client credentials. |
| `CalendarToolset`, `BigQueryToolset`, `GmailToolset`, `YoutubeToolset`, `SlidesToolset`, `SheetsToolset`, `DocsToolset` | Service-specific `GoogleApiToolset` subclasses that construct isolated toolset instances with `{clientId, clientSecret, toolFilter}` options. |
| `GoogleApiTool` | Wraps a single `RestApiTool` and accepts `{clientId, clientSecret}` in its constructor or via `configureAuth(clientId, clientSecret)`. |

All classes in this subsystem carry the `@experimental` decorator and log a one-time warning when instantiated or called.

## Get started

The following example configures OAuth 2.0 client credentials on a `CalendarToolset` and hands it to an `LlmAgent`.

```ts
import {CalendarToolset, LlmAgent} from '@google/adk';

const calendarToolset = new CalendarToolset({
  clientId: process.env.GOOGLE_CLIENT_ID ?? 'demo-client-id',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? 'demo-client-secret',
});

export const rootAgent = new LlmAgent({
  name: 'calendar_agent',
  model: 'gemini-flash-latest',
  description: 'Reads calendar metadata and lists upcoming events.',
  instruction:
    'Use calendar_calendars_get and calendar_events_list to answer questions about the user calendar.',
  tools: [calendarToolset],
});
```

## How it works

When an agent resolves tools from a `GoogleApiToolset`, two stages run in sequence.

### 1. Discovery conversion and OpenID Connect creation

When `getTools()` is called, `GoogleApiToolset` fetches the Discovery document from `https://www.googleapis.com/discovery/v1/apis/{apiName}/{apiVersion}/rest`. It translates the document into OpenAPI v3.0.0 format, selects the first declared OAuth 2.0 scope, and initializes an `OpenAPIToolset` with Google OpenID Connect authentication endpoints. Each Discovery operation `id` is converted to `snake_case`, so `calendar.calendars.get` becomes `calendar_calendars_get`.

### 2. Lazy loading and credential propagation

`GoogleApiToolset` defers network discovery until `getTools()` runs. Concurrent calls to `getTools()` share a single in-flight loading promise. Calling `configureAuth(clientId, clientSecret)` before `getTools()` stores the credentials and applies them when tools load. Calling `configureAuth` after loading updates every tool immediately.

## Configuration options

### GoogleApiToolsetOptions

`new GoogleApiToolset(options)` and the seven service-specific toolset classes accept a `GoogleApiToolsetOptions` object.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `apiName` | `string` | `undefined` | Google Discovery API identifier, such as `'calendar'` or `'gmail'`. |
| `apiVersion` | `string` | `undefined` | Google Discovery API version string, such as `'v3'` or `'v1'`. |
| `clientId` | `string` | `undefined` | OAuth 2.0 client ID applied to every `GoogleApiTool` in the toolset. |
| `clientSecret` | `string` | `undefined` | OAuth 2.0 client secret applied to every `GoogleApiTool` in the toolset. |
| `toolFilter` | `ToolPredicate \| string[]` | `[]` | Selects which tools `getTools()` exposes to the agent. An empty array exposes every tool. |

`toolFilter` accepts an array of tool names or a `(tool, readonlyContext?) => boolean` predicate function. It can be updated at runtime with `setToolFilter(toolFilter)`.

### GoogleApiToolOptions

`new GoogleApiTool(restApiTool, options)` accepts an optional `GoogleApiToolOptions` object (`{clientId?: string; clientSecret?: string}`). When either credential is provided, the constructor configures OpenID Connect OAuth 2.0 client credentials on the tool.

## Advanced applications

### Loading any Google Discovery API on demand

For a Google API that is not among the seven pre-configured toolsets, construct a `GoogleApiToolset` with `apiName` and `apiVersion`:

```ts
import {GoogleApiToolset} from '@google/adk';

const driveToolset = new GoogleApiToolset({
  apiName: 'drive',
  apiVersion: 'v3',
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  toolFilter: ['drive_files_list', 'drive_files_get'],
});
```

## Limitations

- **Node.js entry point only.** `google_api_tool` is exported from the Node entry point of `@google/adk`, not from the browser bundle `@google/adk/web`.
- **First scope selection.** `GoogleApiToolset` selects the first OAuth 2.0 scope declared in the Discovery document.

## Related samples

- [samples/tools/google_api_tool/](../../../../samples/tools/google_api_tool/README.md) - Instantiates a `CalendarToolset`, configures OpenID Connect credentials, and executes a tool call through an agent.
- [Tool samples](../../../../samples/tools/README.md) - Overview of all tool samples and how to run and type-check them.

## Related guides

- [OpenAPI tool](../openapi_tool/index.md) - Parsing OpenAPI v3 specifications into `RestApiTool` instances with `OpenAPIToolset`.
- [Auth](../../auth/index.md) - `AuthCredential`, `OpenIdConnectWithConfig`, and the credential exchange pipeline.
