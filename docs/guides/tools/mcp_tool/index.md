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
I/O in its constructor. Discovery and execution happen lazily over a shared
client session managed by `MCPSessionManager`.

**1. Discovery opens and caches a shared session.** When the runner or caller
invokes `mcpToolset.getTools(context)`, `MCPSessionManager.getSession()` lazily
imports `@modelcontextprotocol/sdk`, opens a client connection using the
configured transport, caches the connected session on the toolset, and calls
`listTools()`.

**2. Each remote definition becomes an `MCPTool`.** `MCPToolset` wraps each
entry from `listTools()` in an `MCPTool`. If the toolset was constructed with a
`prefix`, the wrapper's exposed name becomes `${prefix}_${tool.name}` so two
MCP servers on the same agent do not collide, while `MCPTool` retains the
unprefixed `originalName` for the wire call. `MCPToolset` then applies
`toolFilter` to the wrapped list before returning it.

**3. Declarations are translated to Gemini schemas.** When the agent builds its
`LlmRequest`, each `MCPTool` converts `inputSchema` and `outputSchema` into
`@google/genai` `Schema` objects through `toGeminiSchema`. JSON Schema type
strings become Gemini `Type` enum values, and nullable unions such as
`['string', 'null']` or `anyOf` branches containing `{type: 'null'}` become
`nullable: true`.

**4. Tool and resource calls reuse the shared session.** When the model invokes
an `MCPTool`, `runAsync` acquires the cached session through
`MCPSessionManager.getSession()`, calls `session.callTool` with the unprefixed
`originalName`, the model's arguments, and `toolContext.abortSignal`, and
returns the `CallToolResult` while keeping the session open for subsequent tool
and resource calls. If the transport disconnects, the stale session is dropped
and the next call reconnects automatically. `Runner.runAsync` calls
`mcpToolset.close()` in a `finally` block when an invocation finishes, and
callers using `MCPToolset` directly outside `Runner` should call
`await mcpToolset.close()` when done so stdio subprocesses and HTTP streams
terminate cleanly.

## Configuration options

### MCPToolset

`MCPToolset` takes three positional arguments: `new MCPToolset(connectionParams, toolFilter, prefix)`.

| Argument           | Type                        | Default     | Description                                                                                                   |
| :----------------- | :-------------------------- | :---------- | :------------------------------------------------------------------------------------------------------------ |
| `connectionParams` | `MCPConnectionParams`       | required    | Transport parameters for `StdioConnectionParams`, `StreamableHTTPConnectionParams`, or `SseConnectionParams`. |
| `toolFilter`       | `ToolPredicate \| string[]` | `[]`        | Selects which discovered tools `getTools()` returns.                                                          |
| `prefix`           | `string`                    | `undefined` | Prepends `${prefix}_` to the tool name exposed to the model.                                                  |

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

| Option         | Type                      | Default     | Description                                                                                   |
| :------------- | :------------------------ | :---------- | :-------------------------------------------------------------------------------------------- |
| `type`         | `'StdioConnectionParams'` | required    | Selects `StdioClientTransport`.                                                               |
| `serverParams` | `StdioServerParameters`   | required    | Command, arguments, environment, and working directory passed to the MCP SDK stdio transport. |
| `timeout`      | `number`                  | `undefined` | Optional connection timeout value carried on the parameter object.                            |

`serverParams` is passed straight to `StdioClientTransport` from
`@modelcontextprotocol/sdk/client/stdio.js`, so any field supported by the MCP
SDK's `StdioServerParameters`, such as `command`, `args`, `env`, or `cwd`, works
without wrapper translation.

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

**Session lifecycle and cleanup.** `MCPToolset.getTools()`, `listResources()`,
`getResourceInfo()`, `readResource()`, and `MCPTool.runAsync()` reuse one shared
client session per `MCPToolset` until `mcpToolset.close()` runs. Because
`Runner.runAsync` calls `close()` on agent toolsets when an invocation ends,
in-memory state held inside a stdio subprocess persists across all tool and
resource calls within an invocation and resets on the next `Runner.runAsync`
call unless the server runs externally over Streamable HTTP or SSE or persists
its state. Callers that invoke `MCPToolset` methods directly outside `Runner`
should call `await mcpToolset.close()` when done so child processes and open
transports do not keep the Node event loop alive.

**Predicate filter evaluates with optional context.** Passing a `ToolPredicate` function as
`toolFilter` evaluates the predicate for every discovered tool. When `getTools()` is called without
a context argument, the predicate receives `undefined` for its second parameter.

**Timeout fields on connection parameters.** `timeout`, `sseReadTimeout`, and
`terminateOnClose` on `StdioConnectionParams`,
`StreamableHTTPConnectionParams`, and `SseConnectionParams` are accepted on the
parameter interfaces for configuration compatibility, while
`MCPSessionManager.createSession()` constructs the underlying MCP SDK transports
with `serverParams` or with `new URL(url)` and `transportOptions`. Configure
transport-level request options through `transportOptions` when the MCP SDK
transport requires them.

## Related samples

- [MCP tool](../../../../samples/tools/mcp_tool/README.md) - Connects an agent to a local stdio MCP server, loads MCP resources, and converts an ADK `FunctionTool` schema into an MCP `Tool` definition with `genaiSchemaToJsonSchema`.
- [Tool samples](../../../../samples/tools/README.md) - The tool sample category, how to run and type-check the samples, and what CI verifies.
