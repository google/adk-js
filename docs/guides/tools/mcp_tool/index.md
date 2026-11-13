# MCP tool

`MCPToolset` connects to a Model Context Protocol server, discovers the tools it
advertises, and gives an agent one `MCPTool` per remote tool. The rest of
`core/src/tools/mcp/` and the schema utilities re-exported alongside it handle
the transport session, server resources, and the bidirectional conversion
between Gemini function declarations and MCP JSON Schemas.

## Introduction

A tool server that speaks the Model Context Protocol already publishes its tool
names, descriptions, and JSON Schema parameters over the wire. Wrapping each
remote operation in a hand-written `FunctionTool` duplicates the schema in your
application and requires a code change whenever the server adds or updates a
tool. `MCPToolset` queries the server at runtime through `MCPSessionManager` and
builds the `MCPTool` wrappers automatically.

Reach for `MCPToolset` when the target service is an MCP server reached over
standard input and output, Streamable HTTP, or HTTP with Server-Sent Events.
When the service is an ordinary HTTP API with an OpenAPI v3 specification, use
[OpenAPIToolset](../openapi_tool/index.md) instead. When you are building an MCP
server yourself and want to expose an existing ADK tool's parameter schema as
JSON Schema, use `genaiSchemaToJsonSchema` or `toJsonSchema`.

| Symbol                                     | You touch it when                                                                      |
| :----------------------------------------- | :------------------------------------------------------------------------------------- |
| `MCPToolset`                               | You want an agent to discover and call tools from an MCP server.                       |
| `StdioConnectionParams`                    | The MCP server runs as a local child process over `stdin` and `stdout`.                |
| `StreamableHTTPConnectionParams`           | The MCP server exposes a Streamable HTTP endpoint.                                     |
| `SseConnectionParams` / `SseServerParams`  | The MCP server exposes an HTTP+SSE endpoint.                                           |
| `LoadMcpResourceTool`                      | You want the agent to list and read MCP server resources into the prompt context.      |
| `MCPTool`                                  | You are wrapping a single MCP `Tool` definition directly rather than listing a server. |
| `MCPSessionManager`                        | You are managing MCP client sessions or building `MCPTool` instances yourself.         |
| `genaiSchemaToJsonSchema` / `toJsonSchema` | You need the JSON Schema equivalent of a Gemini `Schema` or `SchemaLike`.              |
| `toGeminiSchema`                           | You need the Gemini `Schema` equivalent of an MCP or JSON Schema object.               |

## Get started

Give `MCPToolset` a connection configuration and pass the toolset in the
agent's `tools` array. The example below launches a local MCP server script over
standard input and output and hands every tool it advertises to an `LlmAgent`.

```ts
import {LlmAgent, MCPToolset} from '@google/adk';
import type {StdioConnectionParams} from '@google/adk';

const connectionParams: StdioConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {
    command: 'node',
    args: ['mcp_server.mjs'],
  },
};

const mcpToolset = new MCPToolset(connectionParams);

export const rootAgent = new LlmAgent({
  name: 'mcp_assistant',
  model: 'gemini-flash-latest',
  description: 'Answers questions using tools from a local MCP server.',
  instruction:
    'Use the MCP tools to look up information requested by the user.',
  tools: [mcpToolset],
});
```

When the MCP server runs over HTTP instead of a child process, pass
`StreamableHTTPConnectionParams` for the Streamable HTTP transport or
`SseConnectionParams` for the HTTP+SSE transport.

```ts
import {MCPToolset} from '@google/adk';
import type {
  SseConnectionParams,
  StreamableHTTPConnectionParams,
} from '@google/adk';

const streamableParams: StreamableHTTPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:8788/mcp',
};

const sseParams: SseConnectionParams = {
  type: 'SseConnectionParams',
  url: 'http://localhost:8090/sse',
  headers: {Authorization: 'Bearer demo-token'},
};

const streamableToolset = new MCPToolset(streamableParams);
const sseToolset = new MCPToolset(sseParams);
```

## How it works

Unlike a static specification parser, `MCPToolset` does no network or process
I/O in its constructor. Discovery and execution happen on demand across short
sessions managed by `MCPSessionManager`.

**1. Discovery opens a session and lists the server's tools.** When the runner
or caller invokes `mcpToolset.getTools(context)`, `MCPSessionManager` lazily
imports `@modelcontextprotocol/sdk`, opens a client connection using the
configured transport, calls `listTools()`, and closes the discovery session in a
`finally` block.

**2. Each remote definition becomes an `MCPTool`.** `MCPToolset` wraps each
entry from `listTools()` in an `MCPTool`. If the toolset was constructed with a
`prefix`, the wrapper's exposed name becomes `${prefix}_${tool.name}` so two
MCP servers on the same agent do not collide, while `MCPTool` retains the
unprefixed `originalName` for the wire call. `MCPToolset` then applies
`toolFilter` to the wrapped list before returning it.

**3. Declarations are translated to Gemini schemas.** When the agent builds its
`LlmRequest`, each `MCPTool` converts `inputSchema` and `outputSchema` into
`@google/genai` `Schema` objects through `toGeminiSchema`. JSON Schema type
strings become Gemini `Type` enum values, nullable unions such as
`['string', 'null']` or `anyOf` branches containing `{type: 'null'}` become
`nullable: true`, and supported `format` values (`'int32'` and `'int64'` on
`integer` or `number`, `'date-time'` and `'enum'` on `string`) are preserved
while unsupported formats are dropped.

**4. Each tool call runs in its own session.** `MCPTool` extends
`BaseAuthenticatedTool`. When the model invokes it, `runAsync` first resolves a
credential if the tool has an `authConfig` (see
[Authenticating tool calls](#authenticating-tool-calls)); without one it goes
straight to the call. The call opens a session through
`MCPSessionManager.createSession(headers)`, with the authentication headers if
there are any, calls `session.callTool` with the unprefixed `originalName`, the
model's arguments, and
`this.mcpSessionManager.getRequestOptions(toolContext.abortSignal)`, returns the
`CallToolResult`, and closes the session in `finally`. Calling
`mcpToolset.close()` closes any sessions that are still active on the session
manager.

## Configuration options

### MCPToolset

`MCPToolset` takes an `MCPToolsetOptions` object,
`new MCPToolset({connectionParams, toolFilter, prefix, authConfig})`, or the
positional arguments `new MCPToolset(connectionParams, toolFilter, prefix)`.
Only the options object accepts the authentication options.

| Option             | Type                        | Default     | Description                                                                                                    |
| :----------------- | :-------------------------- | :---------- | :------------------------------------------------------------------------------------------------------------- |
| `connectionParams` | `MCPConnectionParams`       | required    | Transport parameters for `StdioConnectionParams`, `StreamableHTTPConnectionParams`, or `SseConnectionParams`.  |
| `toolFilter`       | `ToolPredicate \| string[]` | `[]`        | Selects which discovered tools `getTools()` returns.                                                           |
| `prefix`           | `string`                    | `undefined` | Prepends `${prefix}_` to the tool name exposed to the model.                                                   |
| `authConfig`       | `AuthConfig`                | `undefined` | Experimental. Authentication configuration given to every discovered `MCPTool`; applies to tool calls only.    |
| `authScheme`       | `AuthScheme`                | `undefined` | Experimental. Alternative to `authConfig`: the auth scheme for every discovered `MCPTool`.                     |
| `authCredential`   | `AuthCredential`            | `undefined` | The raw credential for `authScheme`. Requires `authScheme`.                                                    |
| `credentialKey`    | `string`                    | derived     | The credential service key for `authScheme`. Defaults to a key derived from `authScheme` and `authCredential`. |

`toolFilter` accepts either a list of tool names or a `(tool, readonlyContext?) => boolean`
predicate. A `string[]` filter matches against the tool's exposed name, which
includes `${prefix}_` when `prefix` is set, and runs whether or not `getTools()`
receives a `ReadonlyContext`. A `ToolPredicate` receives an optional `ReadonlyContext`. An
empty array disables filtering and returns every tool.

`prefix` namespaces the tool names the model sees without changing the name sent
to the MCP server. Because a string-array `toolFilter` runs after prefixing, list
the prefixed names in `toolFilter` when you combine both options.

### StdioConnectionParams

Use `StdioConnectionParams` when the MCP server runs as a local subprocess.

| Option         | Type                      | Default     | Description                                                                                                                                                    |
| :------------- | :------------------------ | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | `'StdioConnectionParams'` | required    | Selects `StdioClientTransport`.                                                                                                                                |
| `serverParams` | `StdioServerParameters`   | required    | Command, arguments, environment, and working directory passed to the MCP SDK stdio transport.                                                                  |
| `timeout`      | `number`                  | `undefined` | Request timeout in seconds for stdio session initialization, tool discovery, resource operations, and tool execution. When unset, the MCP SDK default applies. |

`serverParams` is passed straight to `StdioClientTransport` from
`@modelcontextprotocol/sdk/client/stdio.js`, so any field supported by the MCP
SDK's `StdioServerParameters`, such as `command`, `args`, `env`, or `cwd`, works
without wrapper translation. `MCPSessionManager.getRequestOptions()` converts
`timeout` from seconds into milliseconds on the MCP SDK `RequestOptions`.

### StreamableHTTPConnectionParams

Use `StreamableHTTPConnectionParams` for MCP servers that implement the
Streamable HTTP transport.

| Option             | Type                                   | Default     | Description                                                                                                            |
| :----------------- | :------------------------------------- | :---------- | :--------------------------------------------------------------------------------------------------------------------- |
| `type`             | `'StreamableHTTPConnectionParams'`     | required    | Selects `StreamableHTTPClientTransport`.                                                                               |
| `url`              | `string`                               | required    | Endpoint URL of the Streamable HTTP MCP server.                                                                        |
| `transportOptions` | `StreamableHTTPClientTransportOptions` | `undefined` | Options forwarded to `StreamableHTTPClientTransport`, including `requestInit`, `reconnectionOptions`, and `sessionId`. |
| `header`           | `Record<string, unknown>`              | `undefined` | Deprecated fallback headers used only when `transportOptions.requestInit` is `undefined`.                              |
| `timeout`          | `number`                               | `undefined` | Optional connection timeout value carried on the parameter object.                                                     |
| `sseReadTimeout`   | `number`                               | `undefined` | Optional stream read timeout value carried on the parameter object.                                                    |
| `terminateOnClose` | `boolean`                              | `undefined` | Optional termination flag carried on the parameter object.                                                             |

`MCPSessionManager` merges the ADK tracking headers, `x-goog-api-client` and
`user-agent`, into `transportOptions.requestInit.headers` on a fresh copy so the
caller's `transportOptions` object is never mutated. Prefer
`transportOptions.requestInit.headers` over the deprecated `header` field: once
`transportOptions.requestInit` is defined, `header` is ignored.

### SseConnectionParams

Use `SseConnectionParams`, also exported under the alias `SseServerParams`, for
MCP servers that implement the HTTP+SSE transport.

| Option             | Type                        | Default     | Description                                                                                                         |
| :----------------- | :-------------------------- | :---------- | :------------------------------------------------------------------------------------------------------------------ |
| `type`             | `'SseConnectionParams'`     | required    | Selects `SSEClientTransport`.                                                                                       |
| `url`              | `string`                    | required    | SSE endpoint URL of the MCP server.                                                                                 |
| `headers`          | `Record<string, unknown>`   | `undefined` | HTTP headers merged into `requestInit.headers` when `transportOptions.requestInit` is `undefined`.                  |
| `header`           | `Record<string, unknown>`   | `undefined` | Deprecated alias for `headers`; takes precedence over `headers` when `transportOptions.requestInit` is `undefined`. |
| `transportOptions` | `SSEClientTransportOptions` | `undefined` | Options forwarded to `SSEClientTransport`, including `eventSourceInit` and `requestInit`.                           |
| `timeout`          | `number`                    | `undefined` | Optional connection timeout value carried on the parameter object.                                                  |
| `sseReadTimeout`   | `number`                    | `undefined` | Optional SSE read timeout value carried on the parameter object.                                                    |

As with Streamable HTTP, `MCPSessionManager` merges the ADK tracking headers
into `requestInit.headers` without mutating the input object. When
`transportOptions.requestInit` is provided, its `headers` win over both `header`
and `headers`.

## Advanced applications

### Loading MCP server resources into the prompt

MCP servers can advertise named resources alongside tools. `MCPToolset` exposes
`listResources()`, `getResourceInfo(name)`, and `readResource(name)` for manual
access, and `LoadMcpResourceTool` packages that flow into a tool the model can
call on its own.

```ts
import {LlmAgent, LoadMcpResourceTool, MCPToolset} from '@google/adk';
import type {StdioConnectionParams} from '@google/adk';

const connectionParams: StdioConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'node', args: ['mcp_server.mjs']},
};

const mcpToolset = new MCPToolset(connectionParams);
const loadMcpResource = new LoadMcpResourceTool(mcpToolset);

export const rootAgent = new LlmAgent({
  name: 'resource_reader_agent',
  model: 'gemini-flash-latest',
  description: 'Reads MCP server resources and answers questions about them.',
  tools: [mcpToolset, loadMcpResource],
});
```

Before each model call, `LoadMcpResourceTool.processLlmRequest` calls
`mcpToolset.listResources()`. When the server advertises resources, the tool
appends system instructions naming them and telling the model to call
`load_mcp_resource` with `resource_names`. On the turn after the model calls
`load_mcp_resource`, `processLlmRequest` reads each requested resource through
`mcpToolset.readResource(name)` and appends the text or base64-encoded binary
`inlineData` parts to the outgoing `LlmRequest`.

### Authenticating tool calls

Authentication is experimental. Give `MCPToolset` an `authConfig` to send a
credential with each tool call. Every `MCPTool` that `getTools()` returns
carries the same `authConfig`, and resolves the credential through the
`BaseAuthenticatedTool` flow before it opens the session for the call. If no
credential is available yet, for example before the user completes an OAuth2
consent, the tool asks the client for one with `toolContext.requestCredential`
and returns `'Pending User Authorization.'` instead of calling the server.

The example below sends an API key in the `X-API-Key` header of a Streamable
HTTP server. An API key, like other simple credentials, goes in
`rawAuthCredential` and needs no exchange.

```ts
import {AuthCredentialTypes, MCPToolset} from '@google/adk';

const apiKeyToolset = new MCPToolset({
  connectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'http://localhost:8788/mcp',
  },
  authConfig: {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
    rawAuthCredential: {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: process.env.MCP_API_KEY,
    },
    credentialKey: 'mcp-api-key',
  },
});
```

For OAuth2, give the scheme and the client credentials. The client runs the
consent flow; ADK exchanges the authorization code and sends the access token.

```ts
import {AuthCredentialTypes, MCPToolset} from '@google/adk';

const oauthToolset = new MCPToolset({
  connectionParams: {
    type: 'SseConnectionParams',
    url: 'https://mcp.example.com/sse',
  },
  authConfig: {
    authScheme: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: {'tools.read': 'Call the MCP tools'},
        },
      },
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: process.env.MCP_CLIENT_ID,
        clientSecret: process.env.MCP_CLIENT_SECRET,
      },
    },
    credentialKey: 'mcp-oauth2',
  },
});
```

Instead of an `authConfig`, you can give `authScheme` and `authCredential`, as
the OpenAPI and API Hub toolsets take them. Without a `credentialKey`, the
toolset derives one from the scheme and the credential, leaving out the OAuth2
fields that change during sign-in (`state`, `authCode`, `accessToken` and the
like), so the key stays the same before and after the user signs in. Giving
`authConfig` together with any of `authScheme`, `authCredential` or
`credentialKey` throws an error, and so does `authCredential` or
`credentialKey` without `authScheme`.

```ts
import {AuthCredentialTypes, MCPToolset} from '@google/adk';

const schemeToolset = new MCPToolset({
  connectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'http://localhost:8788/mcp',
  },
  authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
  authCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env.MCP_API_KEY,
  },
});
```

`MCPTool` turns the resolved credential into HTTP headers:

| Credential                                     | Headers sent                                                       |
| :--------------------------------------------- | :----------------------------------------------------------------- |
| OAuth2 with `accessToken`                      | `Authorization: Bearer <accessToken>`; no header without a token   |
| HTTP `bearer` with `token`                     | `Authorization: Bearer <token>`                                    |
| HTTP `basic` with `username` and `password`    | `Authorization: Basic <base64(username:password)>`                 |
| HTTP with another scheme and `token`           | `Authorization: <scheme> <token>`                                  |
| HTTP `additionalHeaders`                       | Added to the headers above; replaces a header of the same name     |
| API key with an `apiKey` scheme `in: 'header'` | `<scheme name>: <apiKey>`; another location or a blank name throws |
| Service account                                | None; a warning is logged, because it must be exchanged beforehand |

The headers are added on top of the connection's own headers
(`transportOptions.requestInit.headers`, or `header`/`headers` when
`requestInit` is absent). Header names are compared case-insensitively, so one
header is never sent twice in different casings, and the authentication header
wins. The ADK tracking headers are still merged in.

`MCPTool` also takes an `MCPToolOptions` object,
`new MCPTool({mcpTool, mcpSessionManager, originalName, authConfig})`, when you
build tools yourself. It accepts the same `authScheme`, `authCredential` and
`credentialKey` options as `MCPToolset`.

### Exposing an ADK tool schema from an MCP server

When you already have an ADK `BaseTool`, such as a `FunctionTool`, and want to
serve it from an MCP server built with `@modelcontextprotocol/sdk/server`,
extract the tool's `FunctionDeclaration` via `tool._getDeclaration()` and
convert `declaration.parameters` into a JSON Schema object with
`genaiSchemaToJsonSchema`.

```ts
import {FunctionTool, genaiSchemaToJsonSchema} from '@google/adk';
import {z} from 'zod';

const lookupTicket = new FunctionTool({
  name: 'lookup_ticket',
  description: 'Looks up a support ticket by its identifier.',
  parameters: z.object({
    ticketId: z.string().describe('The ticket identifier, such as T-100.'),
  }),
  execute: async ({ticketId}) => ({ticketId, status: 'open'}),
});

const declaration = lookupTicket._getDeclaration();
const mcpToolDefinition = {
  name: lookupTicket.name,
  description: lookupTicket.description,
  inputSchema: declaration?.parameters
    ? genaiSchemaToJsonSchema(declaration.parameters)
    : {},
};
```

`mcpToolDefinition` has the MCP `Tool` shape `{name, description, inputSchema}`,
ready to return from a `ListToolsRequestSchema` handler.

### Converting schemas directly

The schema conversion functions are also exported for callers that translate
schemas outside a tool wrapper. `toGeminiSchema` converts a JSON Schema or
OpenAPI schema into a `@google/genai` `Schema`, and `genaiSchemaToJsonSchema`
converts a Gemini `Schema` into a standard JSON Schema record. For callers
holding either a Gemini `Schema` or a Zod schema, `toJsonSchema` accepts both.

```ts
import {genaiSchemaToJsonSchema, toGeminiSchema} from '@google/adk';

const geminiSchema = toGeminiSchema({
  type: 'object',
  properties: {
    query: {type: 'string'},
  },
  required: ['query'],
});

const jsonSchema = geminiSchema ? genaiSchemaToJsonSchema(geminiSchema) : {};
```

## Limitations

**Optional peer dependency.** `@modelcontextprotocol/sdk` is an optional peer
dependency loaded lazily when `MCPSessionManager.createSession()` runs. Install
it in any application that opens an MCP session; without it, `createSession()`
throws an error naming the missing package. Schema helpers such as
`genaiSchemaToJsonSchema`, `toJsonSchema`, and `toGeminiSchema` run without the
MCP SDK package installed at runtime.

**Per-operation sessions.** `MCPToolset.getTools()`, `listResources()`,
`getResourceInfo()`, `readResource()`, and `MCPTool.runAsync()` each open a
client session and close it in a `finally` block. In `readResource(name)`,
resolving the resource name to a URI via `getResourceInfo(name)` and reading the
resource contents open two sequential sessions. A stdio MCP server therefore
starts a fresh subprocess for each discovery or tool call unless the server is
hosted externally over Streamable HTTP or SSE.

**Authentication is experimental and covers tool calls only.**
`MCPToolset.getTools()`, `listResources()`, `getResourceInfo()`, and
`readResource()` send no authentication headers, so configure discovery
credentials on the connection parameters. Stdio connections ignore the
authentication headers. API keys are supported only in a header.

**Predicate filter evaluates with optional context.** Passing a `ToolPredicate` function as
`toolFilter` evaluates the predicate for every discovered tool. When `getTools()` is called without
a context argument, the predicate receives `undefined` for its second parameter.

**Timeout fields on connection parameters.**
`StdioConnectionParams.timeout` is in seconds. When it is set,
`MCPSessionManager.getRequestOptions()` applies it to the stdio `connect`,
`listTools`, `listResources`, `readResource`, and `callTool` requests. When it
is unset, the MCP SDK default request timeout applies. The `timeout`,
`sseReadTimeout`, and `terminateOnClose` fields on
`StreamableHTTPConnectionParams` and `SseConnectionParams` are accepted on the
parameter interfaces for configuration compatibility. They are not forwarded to
the HTTP and SSE transports. Configure
HTTP/SSE transport-level options through `transportOptions` when the MCP SDK
transport requires them.

## Related samples

- [MCP tool](../../../../samples/tools/mcp_tool/README.md) - Connects an agent to a local stdio MCP server, loads MCP resources, and converts an ADK `FunctionTool` schema into an MCP `Tool` definition with `genaiSchemaToJsonSchema`.
- [Tool samples](../../../../samples/tools/README.md) - The tool sample category, how to run and type-check the samples, and what CI verifies.
