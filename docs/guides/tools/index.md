# Tools

Tools in the Agent Development Kit expose TypeScript functions, child agents, external tool ecosystems, and model-native capabilities to an `LlmAgent` during an invocation. Every tool extends `BaseTool` or is produced by a `BaseToolset`, participating in two lifecycle phases: mutating the outgoing `LlmRequest` before the model call via `processLlmRequest` and executing tool logic when the model emits a `FunctionCall` via `runAsync` or `_callLive`.

The `tools` subsystem provides core abstractions, ecosystem adapters, built-in model tools, and specialized tool families:

- `BaseTool` and `BaseToolset` - Abstract contracts for individual tools and dynamic collections of tools passed in an `LlmAgent` `tools` array.
- `FunctionTool` and `LongRunningFunctionTool` - Wrap synchronous, asynchronous, or async-generator TypeScript functions with Zod or `@google/genai` `Schema` declarations, optional `response` schemas, human-in-the-loop `requireConfirmation`, and live streaming via `_callLive`.
- `AgentTool` - Wraps any `BaseAgent` as a callable tool, validating arguments and outputs against `inputSchema` and `outputSchema` when wrapping an `LlmAgent` and forwarding session state and artifacts.
- `ToolContext` and `Context` - Provide tool callbacks with access to session `state`, `EventActions` mutations, `saveArtifact` and `loadArtifact`, `searchMemory`, credential exchange, and tool confirmation.
- `CrewaiTool`, `LangchainTool`, and `ToolboxToolset` - Adapt CrewAI tools, LangChain tools, and Google GenAI Toolbox toolsets into ADK tools.
- `GoogleSearchTool`, `VertexAiSearchTool`, `ExitLoopTool`, `ExampleTool`, `LoadArtifactsTool`, `LoadMemoryTool`, `PreloadMemoryTool`, `loadWebPage`, and `getUserChoiceTool` - Built-in and utility tools for grounding, loop control, few-shot prompting, artifact and memory injection, web page text extraction, and interactive user choice.
- [BaseRetrievalTool](retrieval/base_retrieval_tool/index.md) - Abstract base for client-side retrieval tools that return a single highest-scoring text chunk.
- [LlamaIndexRetrieval](retrieval/llama_index_retrieval/index.md) - Client-side retrieval tool backed by any object implementing `retrieve(query)`.
- [FilesRetrieval](retrieval/files_retrieval/index.md) - Client-side retrieval tool that indexes a local directory of documents.
- [OpenAPI tool](openapi_tool/index.md) - `OpenAPIToolset` and `RestApiTool` for generating authenticated REST tools from an OpenAPI specification.
- [API Hub tool](apihub_tool/index.md) - `APIHubToolset` for building REST tools from Google Cloud API Hub specifications.

## Introduction

An `LlmAgent` accepts a `tools` array whose entries can be `BaseTool` instances, `BaseToolset` providers, plain functions, or workflow nodes. Before each model call, the agent resolves its tools and invokes `tool.processLlmRequest({toolContext, llmRequest})` on each active tool. Standard function-based tools append their `@google/genai` `FunctionDeclaration` from `_getDeclaration()` into `llmRequest.config.tools` and register themselves in `llmRequest.toolsDict` by tool name. Request-mutating tools such as `ExampleTool`, `PreloadMemoryTool`, `GoogleSearchTool`, and `VertexAiSearchTool` customize system instructions or built-in retrieval configurations directly on `llmRequest`.

When the model responds with a `FunctionCall` part, the ADK tool execution pipeline looks up the matching tool in `llmRequest.toolsDict`, constructs a `Context` aliased as `ToolContext` bound to the current `InvocationContext` and `functionCall.id`, and calls `tool.runAsync({args, toolContext})`. Any changes the tool makes to `toolContext.state` or `toolContext.actions` are packaged into the resulting `functionResponse` event and persisted by the runner.

## Get started

Define a typed `FunctionTool` with a Zod parameter schema, a `response` output schema, and a `ToolContext` state update, then wire it into an `LlmAgent`.

```ts
import {FunctionTool, LlmAgent, ToolContext} from '@google/adk';
import {Type} from '@google/genai';
import {z} from 'zod';

export const convertCurrencyTool = new FunctionTool({
  name: 'convert_currency',
  description: 'Converts an amount from USD to EUR and records the last query.',
  parameters: z.object({
    amountUsd: z.number().describe('Amount in US dollars.'),
  }),
  response: {
    type: Type.OBJECT,
    properties: {
      amountEur: {type: Type.NUMBER},
      currency: {type: Type.STRING},
    },
    required: ['amountEur', 'currency'],
  },
  execute: async ({amountUsd}, toolContext?: ToolContext) => {
    const amountEur = Number((amountUsd * 0.92).toFixed(2));
    if (toolContext) {
      toolContext.state.set('lastConvertedUsd', amountUsd);
    }
    return {amountEur, currency: 'EUR'};
  },
});

export const currencyAgent = new LlmAgent({
  name: 'currency_assistant',
  model: 'gemini-flash-latest',
  description: 'Converts USD amounts into EUR.',
  instruction:
    'Use convert_currency whenever the user asks for EUR conversion.',
  tools: [convertCurrencyTool],
});
```

## How it works

1. **Declaration generation and schema conversion**: `FunctionTool._getDeclaration()` converts the configured `parameters` and optional `response` schemas into a `@google/genai` `FunctionDeclaration`. Callers can supply a Zod object schema or a `@google/genai` `Schema` for `parameters`, and any `SchemaLike` value for `response`. When `parameters` is omitted, `_getDeclaration()` emits `{type: Type.OBJECT, properties: {}}`. The exported helpers `buildFunctionDeclarationUtil`, `buildFunctionDeclarationForLangchain`, and `buildFunctionDeclarationForParamsForCrewai` build `FunctionDeclaration` objects from normalized parameter schemas, mapping property type names to `@google/genai` `Type` enum values, annotating `nullable` and `required` fields from `anyOf` and `default` descriptors, stripping `anyOf`, `default`, `nullable`, and `title` when `vertexai` is `false`, and setting `declaration.response` when `vertexai` is `true`.
2. **Function execution and confirmation**: When `FunctionTool.runAsync({args, toolContext})` runs, it validates `args` with `parameters.parse(args)` when `parameters` is a Zod object schema and evaluates `requireConfirmation`. If confirmation is required and not yet granted on `toolContext.toolConfirmation`, the tool requests confirmation through `toolContext.requestConfirmation` and sets `toolContext.actions.skipSummarization = true`. For asynchronous operations whose result arrives out of band, `LongRunningFunctionTool` sets `isLongRunning: true` and appends a warning note to the declaration description instructing the model not to re-invoke the tool while a call is already pending.
3. **Live streaming tool execution**: During bidirectional live runs, `FunctionTool._callLive({args, toolContext, invocationContext})` validates `args`, checks `invocationContext.activeStreamingTools[this.name]` for an active `stream`, and injects that stream as `inputStream` into a shallow copy of the arguments object when present. The tool `execute` callback yields incremental updates as an `AsyncGenerator` or `AsyncIterable`, or resolves a single value that `_callLive` yields once.
4. **Child agent delegation**: `AgentTool` exposes a child `BaseAgent` as a tool. Its declaration uses `agent.inputSchema` when the child is an `LlmAgent` with an explicit `inputSchema`, or defaults to `{type: Type.OBJECT, properties: {request: {type: Type.STRING}}, required: ['request']}`, and populates `declaration.response` on non-Gemini API variants. On `runAsync`, when the child `LlmAgent` has an `inputSchema`, `AgentTool` validates `args` with `parseWithSchema` and strips `null` and `undefined` fields before serializing the user message. It runs a child `Runner` with `ForwardingArtifactService` and `sessionService.getOrCreateSession` seeded with `toolContext.state.toRecord()`, forwards non-`temp:` `stateDelta` entries back to `toolContext.state`, and merges non-thought text parts from the last event. When the child `LlmAgent` defines an `outputSchema`, `AgentTool` parses the merged JSON text, validates it against `outputSchema`, and strips `null` and `undefined` values before returning the structured object.
5. **Ecosystem adapters**: `CrewaiTool` wraps a `CrewaiToolLike` object with a `run` method and optional `argsSchema`, normalizing spaces in `tool.name` to lowercase underscores when no custom `name` override is given and delegating `_getDeclaration()` to `buildFunctionDeclarationForParamsForCrewai`. `LangchainTool` wraps a `LangchainToolLike` object exposing `_run`, `_call`, `invoke`, or `run` and optional `argsSchema`, `schema`, or `args`, delegating structured tools to `buildFunctionDeclarationForLangchain` and simple `run`-only tools to `buildFunctionDeclarationUtil`.
6. **Built-in model and control-flow tools**:
   - `GoogleSearchTool` and `GOOGLE_SEARCH` together with `VertexAiSearchTool` extend `BuiltInTool` and attach model-native grounding configurations to `llmRequest.config.tools`.
   - `ExitLoopTool` and `EXIT_LOOP` set `toolContext.actions.escalate = true` and `toolContext.actions.skipSummarization = true` so a surrounding `LoopAgent` stops iterating.
   - `ExampleTool` validates an array of `Example` items or a `BaseExampleProvider` at construction time and appends few-shot examples to `llmRequest` system instructions on each turn.
   - `LoadArtifactsTool` and `LOAD_ARTIFACTS` list available session and user artifacts in system instructions and inject requested artifact `Part` payloads into the current turn `llmRequest.contents`.
   - `LoadMemoryTool` and `LOAD_MEMORY` together with `PreloadMemoryTool` and `PRELOAD_MEMORY` expose on-demand `load_memory` calls or automatic `<PAST_CONVERSATIONS>` instruction injection backed by `BaseMemoryService`.
   - `loadWebPage` and `LOAD_WEB_PAGE` fetch `http:` and `https:` URLs with pre-flight SSRF checks against localhost and non-global IP addresses, extracting readable text lines from the HTML body.
   - `getUserChoiceTool` is a pre-configured `LongRunningFunctionTool` named `get_user_choice` that accepts an `options: string[]` parameter and sets `skipSummarization = true` while awaiting user selection.

## Configuration options

### `BaseToolParams`

The `BaseToolParams` interface defines the base properties accepted by the `BaseTool` constructor.

| Option          | Type      | Default  | Description                                                                                  |
| :-------------- | :-------- | :------- | :------------------------------------------------------------------------------------------- |
| `name`          | `string`  | Required | Tool identifier registered in `llmRequest.toolsDict` and emitted in `FunctionDeclaration`.   |
| `description`   | `string`  | Required | Natural-language description explaining when and how the model should call the tool.         |
| `isLongRunning` | `boolean` | `false`  | Marks the tool as an asynchronous operation whose final result is supplied after invocation. |

Every `BaseTool` requires a `name` and `description`. Setting `isLongRunning` to `true` instructs the runner that the initial `runAsync` return value represents a pending status rather than a completed tool output.

### `ToolOptions`

The `ToolOptions` interface configures `new FunctionTool(options)` and `new LongRunningFunctionTool(options)`.

| Option                | Type                               | Default        | Description                                                                                            |
| :-------------------- | :--------------------------------- | :------------- | :----------------------------------------------------------------------------------------------------- |
| `name`                | `string`                           | `execute.name` | Tool name exposed to the model; required when `execute` is an anonymous function.                      |
| `description`         | `string`                           | Required       | Description included in the generated `FunctionDeclaration`.                                           |
| `parameters`          | `TParameters`                      | `undefined`    | Input parameter schema converted to `@google/genai` `Schema` and used for runtime argument validation. |
| `response`            | `SchemaLike`                       | `undefined`    | Optional return-value schema converted and attached to `FunctionDeclaration.response`.                 |
| `execute`             | `ToolExecuteFunction<TParameters>` | Required       | Synchronous, asynchronous, or async-generator function invoked with `input` and `toolContext`.         |
| `isLongRunning`       | `boolean`                          | `false`        | Marks the function tool as long-running; `LongRunningFunctionTool` forces this option to `true`.       |
| `requireConfirmation` | `RequireConfirmation<TParameters>` | `false`        | Boolean or predicate gating execution on user approval via `toolContext.requestConfirmation`.          |

When `parameters` is a Zod object, `FunctionTool` parses incoming `args` before calling `execute` and converts the schema to a `@google/genai` `Schema` for `FunctionDeclaration.parameters`. When `response` is supplied as a Zod schema or `@google/genai` `Schema`, `_getDeclaration()` populates `FunctionDeclaration.response`.

### `AgentToolConfig`

The `AgentToolConfig` interface configures `new AgentTool(config)`.

| Option              | Type        | Default  | Description                                                                                    |
| :------------------ | :---------- | :------- | :--------------------------------------------------------------------------------------------- |
| `agent`             | `BaseAgent` | Required | Child agent invoked when the model calls the tool, using `agent.name` and `agent.description`. |
| `skipSummarization` | `boolean`   | `false`  | Configures whether summarization of the child agent output is skipped.                         |

When `agent` is an `LlmAgent` with `inputSchema`, `AgentTool` uses that schema as its parameter declaration, validates tool arguments with `parseWithSchema`, and strips `null` and `undefined` fields before running the child agent. When `agent` also defines `outputSchema`, `AgentTool` parses the final text response as JSON, validates it against `outputSchema`, and strips `null` and `undefined` fields.

### `CrewaiToolConfig`

The `CrewaiToolConfig` interface configures `new CrewaiTool(config)` or `new CrewaiTool(tool, options?)`.

| Option        | Type             | Default                | Description                                                                                    |
| :------------ | :--------------- | :--------------------- | :--------------------------------------------------------------------------------------------- |
| `tool`        | `CrewaiToolLike` | Required               | CrewAI tool object exposing `run` and optional `name`, `description`, and `argsSchema`.        |
| `name`        | `string`         | Normalized `tool.name` | Optional non-empty override for the wrapped tool name; empty strings fall back to `tool.name`. |
| `description` | `string`         | `tool.description`     | Optional non-empty override for the wrapped tool description.                                  |

When `name` is omitted or empty, `CrewaiTool` normalizes `tool.name` by replacing spaces with underscores and lowercasing the string, falling back to `tool.run.name` or `'crewai_tool'`. `CrewaiTool._getDeclaration()` converts `tool.argsSchema` and delegates to `buildFunctionDeclarationForParamsForCrewai`.

### `LangchainToolConfig`

The `LangchainToolConfig` interface configures `new LangchainTool(config)` or `new LangchainTool(tool, options?)`.

| Option        | Type                | Default            | Description                                                                                                     |
| :------------ | :------------------ | :----------------- | :-------------------------------------------------------------------------------------------------------------- |
| `tool`        | `LangchainToolLike` | Required           | LangChain tool object exposing `_run`, `_call`, `invoke`, or `run` and optional `argsSchema`, `schema`, `args`. |
| `name`        | `string`            | `tool.name`        | Optional non-empty override for the wrapped tool name.                                                          |
| `description` | `string`            | `tool.description` | Optional non-empty override for the wrapped tool description.                                                   |

`LangchainTool` binds the first available runner method from `_run`, `_call`, `invoke`, or `run`, throwing a `TypeError` at construction time if none is present. Structured tools with `_run`, `_call`, `invoke`, `argsSchema`, `schema`, or `args` build their declaration via `buildFunctionDeclarationForLangchain`, whereas simple `run`-only tools delegate to `buildFunctionDeclarationUtil`.

### `ToolboxToolsetOptions`

The `ToolboxToolsetOptions` interface configures `new ToolboxToolset(options)` or `new ToolboxToolset(serverUrl, options)`.

| Option             | Type                                              | Default     | Description                                                                                              |
| :----------------- | :------------------------------------------------ | :---------- | :------------------------------------------------------------------------------------------------------- |
| `serverUrl`        | `string`                                          | Required    | Base URL of the Google GenAI Toolbox server.                                                             |
| `toolsetName`      | `string`                                          | `undefined` | Name of the Toolbox toolset to load; at least one of `toolsetName` or `toolNames` is required.           |
| `toolNames`        | `readonly string[]`                               | `undefined` | Individual tool names to load from the Toolbox server.                                                   |
| `authTokenGetters` | `Record<string, () => string \| Promise<string>>` | `{}`        | Mapping of authentication service names to callables returning authentication tokens.                    |
| `boundParams`      | `Record<string, unknown>`                         | `{}`        | Mapping of parameter names bound to fixed values or value-producing callables.                           |
| `client`           | `ToolboxToolsetClientLike`                        | `undefined` | Optional pre-configured Toolbox client implementing `loadToolset`/`load_toolset` and `loadTool`/`close`. |
| `toolFilter`       | `ToolPredicate \| string[]`                       | `[]`        | Optional filter restricting which loaded tools are returned by `getTools(context)`.                      |
| `prefix`           | `string`                                          | `undefined` | Optional prefix prepended (`${prefix}_`) to every loaded tool name.                                      |

`ToolboxToolset` extends `BaseToolset`, loads tools asynchronously via `getTools(context)` while forwarding `authTokenGetters` and `boundParams`, wraps functions and tool descriptors into `BaseTool` instances, and releases client resources via `close()`.

### `VertexAiSearchToolParams`

The `VertexAiSearchToolParams` union of `DataStoreParams` and `SearchEngineParams` configures `new VertexAiSearchTool(params)`.

| Option                  | Type                            | Default     | Description                                                                                     |
| :---------------------- | :------------------------------ | :---------- | :---------------------------------------------------------------------------------------------- |
| `dataStoreId`           | `string`                        | `undefined` | Vertex AI Search data store resource path; mutually exclusive with `searchEngineId`.            |
| `searchEngineId`        | `string`                        | `undefined` | Vertex AI Search engine resource path; mutually exclusive with `dataStoreId`.                   |
| `dataStoreSpecs`        | `VertexAISearchDataStoreSpec[]` | `undefined` | Optional data store specifications; requires `searchEngineId` to be set.                        |
| `filter`                | `string`                        | `undefined` | Filter expression applied to Vertex AI Search queries.                                          |
| `maxResults`            | `number`                        | `undefined` | Maximum number of search results returned per query.                                            |
| `bypassMultiToolsLimit` | `boolean`                       | `false`     | Allows combining `VertexAiSearchTool` with other tools on Gemini 1.x models when set to `true`. |

Exactly one of `dataStoreId` or `searchEngineId` must be supplied. Passing `dataStoreSpecs` without `searchEngineId` throws an error at construction time.

## Advanced applications

### Delegating structured tasks with `AgentTool`, `inputSchema`, and `outputSchema`

Wrap a specialist `LlmAgent` that declares both `inputSchema` and `outputSchema` in an `AgentTool` so a parent orchestrator calls it with validated arguments and receives a validated structured response with `null` and `undefined` fields stripped.

```ts
import {AgentTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const ticketAnalyzer = new LlmAgent({
  name: 'ticket_analyzer',
  model: 'gemini-flash-latest',
  description: 'Classifies support tickets by severity and component.',
  instruction: 'Return a JSON object matching the output schema.',
  inputSchema: z.object({
    subject: z.string(),
    body: z.string(),
    priorityHint: z.string().nullable().optional(),
  }),
  outputSchema: z.object({
    severity: z.enum(['low', 'medium', 'high']),
    component: z.string(),
  }),
});

export const ticketTool = new AgentTool({
  agent: ticketAnalyzer,
  skipSummarization: false,
});
```

### Streaming live updates from `FunctionTool._callLive`

Define an async-generator `FunctionTool` that reads incremental `LiveRequest` messages from `inputStream` during a live streaming invocation and yields updates as they arrive.

```ts
import {FunctionTool, LiveRequestQueue} from '@google/adk';
import {z} from 'zod';

export const liveSensorMonitor = new FunctionTool({
  name: 'monitor_sensor',
  description: 'Streams threshold alerts from a live request queue.',
  parameters: z.object({
    threshold: z.number(),
  }),
  execute: async function* (args: Record<string, unknown>) {
    const threshold = Number(args.threshold ?? 0);
    const inputStream = args.inputStream as LiveRequestQueue | undefined;
    if (!inputStream) {
      return;
    }
    for await (const request of inputStream) {
      const text = request.content?.parts?.[0]?.text;
      const reading = text !== undefined ? Number(text) : Number.NaN;
      if (!Number.isNaN(reading) && reading >= threshold) {
        yield {alert: true, reading};
      }
    }
  },
});
```

### Adapting CrewAI, LangChain, and GenAI Toolbox tools

Wrap existing CrewAI tools, LangChain structured tools, and GenAI Toolbox clients so they run inside an ADK `LlmAgent` without rewriting their tool handlers.

```ts
import {CrewaiTool, LangchainTool, ToolboxToolset} from '@google/adk';
import {z} from 'zod';

export const crewSearchTool = new CrewaiTool(
  {
    name: 'Repo Lookup',
    description: 'Searches repository metadata by owner and name.',
    argsSchema: z.object({owner: z.string(), repo: z.string()}),
    run: async (args: Record<string, unknown>) => ({
      fullName: `${String(args.owner)}/${String(args.repo)}`,
    }),
  },
  {
    name: 'custom_repo_lookup',
    description: 'Looks up repository details by owner and name.',
  },
);

export const langchainCalculatorTool = new LangchainTool({
  tool: {
    name: 'multiply_numbers',
    description: 'Multiplies two numbers.',
    argsSchema: z.object({a: z.number(), b: z.number()}),
    invoke: async (args: Record<string, unknown>) =>
      Number(args.a) * Number(args.b),
  },
});

export const asyncToolboxToolset = new ToolboxToolset({
  serverUrl: 'http://127.0.0.1:5000',
  toolsetName: 'support_tools',
  toolNames: ['escalate_ticket'],
  authTokenGetters: {
    support_auth: () => 'bearer-token',
  },
  boundParams: {
    tenantId: 'default-tenant',
  },
  client: {
    loadToolset: async () => [
      {
        name: 'search_kb',
        description: 'Searches the support knowledge base.',
        parameters: z.object({query: z.string()}),
        execute: async ({query}: {query: string}) => ({matched: query}),
      },
    ],
    loadTool: async (name: string) => ({
      name,
      description: `Executes ${name}`,
      execute: async (input: unknown) => ({tool: name, input}),
    }),
  },
});
```

## Limitations

- **Runtime reflection of plain TypeScript function types**: TypeScript erases type annotations at compile time. Pass a Zod object schema or `@google/genai` `Schema` to `FunctionTool` `parameters` and `response`, or pass a parameter schema map to `buildFunctionDeclarationUtil`, so the generated `FunctionDeclaration` carries typed properties.
- **Single-tool constraints on Gemini 1.x built-in search tools**: `GoogleSearchTool` and `VertexAiSearchTool` throw an error if combined with other tools on a `gemini-1.*` model unless `bypassMultiToolsLimit: true` is configured on `VertexAiSearchTool` or a Gemini 2+ model is used.
- **DNS rebinding window in `loadWebPage`**: `loadWebPage` validates URL schemes, rejects localhost hostnames, resolves DNS addresses up front to block private, loopback, link-local, and reserved IPs, and disables HTTP redirects with `redirect: 'manual'`. Because global `fetch` performs its own DNS lookup when opening the socket, a time-of-check/time-of-use window remains between pre-flight resolution and connection establishment.

## Related samples

- [`samples/tools/`](../../../samples/tools/README.md) - Runnable tool samples covering `FunctionTool` with `response` schema and `_callLive` streaming, `LongRunningFunctionTool`, `AgentTool` with `inputSchema` and `outputSchema`, `ExitLoopTool`, `CrewaiTool`, `LangchainTool`, `ToolboxToolset`, `ToolContext` state and artifact operations, retrieval tools, OpenAPI toolsets, and API Hub toolsets.

## Related guides

- [BaseRetrievalTool](retrieval/base_retrieval_tool/index.md) - Abstract base for client-side retrieval tools and comparison with server-side RAG.
- [LlamaIndexRetrieval](retrieval/llama_index_retrieval/index.md) - Client-side retrieval tool backed by a LlamaIndex retriever.
- [FilesRetrieval](retrieval/files_retrieval/index.md) - Directory-backed client-side retrieval tool.
- [OpenAPI tool](openapi_tool/index.md) - Generating `RestApiTool` instances from an OpenAPI specification with `OpenAPIToolset`.
- [API Hub tool](apihub_tool/index.md) - Fetching OpenAPI specs from Google Cloud API Hub with `APIHubToolset`.
- [Artifacts](../artifacts/index.md) - Versioned binary and text artifact storage accessed through `toolContext.saveArtifact` and `LOAD_ARTIFACTS`.
- [Memory](../memory/index.md) - Cross-session memory services accessed through `toolContext.searchMemory`, `LOAD_MEMORY`, and `PRELOAD_MEMORY`.
