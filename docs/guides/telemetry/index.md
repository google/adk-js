# Telemetry

ADK opens an OpenTelemetry span for each step of a run and writes what the
framework knows about that step onto it as attributes. `maybeSetOtelProviders`
is the call that sends those spans, and the metrics and logs beside them, to an
exporter you choose.

## Introduction

A run reaches a trace backend as a tree of spans: the turn, each agent in it,
each model call, and each tool call. The OpenTelemetry SDK records timing and
parentage on its own. It cannot know the framework context around each step, so
ADK adds it: which invocation and session the span belongs to, which agent and
tool, and the request and response payloads that crossed the model boundary.

Two readers depend on those attributes. A trace backend selects and groups spans
by them, which is why they are fixed keys with fixed string values. The `adk web`
dev server reads the same attributes to render its Trace view, and its
`/debug/trace/:eventId` endpoint returns them keyed by
`gcp.vertex.agent.event_id`.

Everything a caller imports is in `@google/adk`: `maybeSetOtelProviders`, the
`OTelHooks` and `OtelExportersConfig` types, `getGcpExporters`,
`getGcpResource`, `getGcpProjectId`, the `RunTelemetryConfig` type with
`ContentCapturingMode`, and `WebUiLogProcessor`. The functions that write the
attributes are called by the framework, and [Limitations](#limitations) explains
why they are not exported.

## Get started

Install a span processor once, before the agent runs, and every span ADK emits
afterwards goes through it. This example prints each span to the console, which
shows the full attribute set without a backend.

```ts
import {FunctionTool, LlmAgent, maybeSetOtelProviders} from '@google/adk';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {z} from 'zod';

maybeSetOtelProviders([
  {spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())]},
]);

const getOrderStatus = new FunctionTool({
  name: 'get_order_status',
  description: 'Looks up the delivery status of one order by its identifier.',
  parameters: z.object({orderId: z.string()}),
  execute: ({orderId}) => ({orderId, status: 'shipped'}),
});

export const rootAgent = new LlmAgent({
  name: 'order_assistant',
  model: 'gemini-flash-latest',
  instruction: 'Call get_order_status for every question that names an order.',
  tools: [getOrderStatus],
});
```

`SimpleSpanProcessor` exports each span as it ends, which suits a console or a
test. `BatchSpanProcessor` buffers spans and sends them together, which is what
a network exporter wants.

## How it works

ADK names each span after the step it covers. Under the default schema (v2), a
prompt that triggers one tool call produces `invoke_workflow <root>`,
`invoke_agent <name>`, `generate_content <model>`, `execute_tool <name>` and a
second `generate_content <model>`: the first model call returns the tool call,
and the second turns the tool response into the answer. [Schema
selection](#schema-selection) shows the tree under both schemas.

| Span                          | Opened for                                                                                              |
| :---------------------------- | :------------------------------------------------------------------------------------------------------ |
| `invoke_workflow <name>`      | One turn, opened by the `Runner` under schema v2 or for a workflow root; and one nested `Workflow` run. |
| `invocation`                  | One turn, opened by the `Runner` under schema v1.                                                       |
| `invoke_agent <name>`         | One agent's part of the turn.                                                                           |
| `call_llm`                    | One request to the model, under schema v1 only.                                                         |
| `generate_content <model>`    | One model inference (OpenTelemetry GenAI span).                                                         |
| `execute_tool <name>`         | One tool call and its response.                                                                         |
| `execute_tool (merged)`       | Parallel tool calls whose responses are merged into one event.                                          |
| `send_data`                   | Replaying session history to a live model connection in `runLive`.                                      |
| `invoke_node <name>`          | One node in a workflow that is not an agent or a workflow.                                              |
| `execute_node_attempt <name>` | One attempt of a workflow node that has a retry configuration.                                          |

An agent or a workflow that runs as a workflow node gets no `invoke_node` span:
its own `invoke_agent` or `invoke_workflow` span takes that place. An agent
reached by `transfer_to_agent` gets an `invoke_agent` span next to the agent
that transferred, under the same parent span. The inner run of an
`AgentTool` opens its own root span under the tool's `execute_tool` span.

### Schema selection

`ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN` selects the span tree, the
`generate_content <model>` attributes and the inference log records. Schema v2
is the default. `1` or `otel_semconv_1_36` selects schema v1. Both trees follow
the OpenTelemetry GenAI semantic conventions the way adk-python does.

The tree of one agent turn with one tool call, under schema v2:

```
invoke_workflow some_root_agent
└ invoke_agent some_root_agent
  ├ generate_content gemini-2.5-flash
  ├ execute_tool some_tool
  └ generate_content gemini-2.5-flash
```

The same turn under schema v1:

```
invocation
└ invoke_agent some_root_agent
  ├ call_llm
  │ └ generate_content gemini-2.5-flash
  ├ execute_tool some_tool
  └ call_llm
    └ generate_content gemini-2.5-flash
```

Before this release, every schema produced this tree:

```
invocation
└ invoke_agent some_root_agent
  ├ call_llm
  │ ├ generate_content gemini-2.5-flash
  │ └ execute_tool some_tool
  └ call_llm
    └ generate_content gemini-2.5-flash
```

What changed in the span tree:

- Schema v2 has no `invocation` and no `call_llm` span. The turn's root is
  `invoke_workflow <root name>`.
- Under schema v1, `call_llm` covers the model call only. Tool calls and
  transfers that follow it are its siblings, and a transferred agent's
  `invoke_agent` span is a sibling of the transferring agent's span.
- Workflow nodes open `invoke_node <name>` instead of `execute_node <name>`,
  with `gen_ai.*` attributes instead of `adk.node.*`. An agent or workflow node
  no longer gets a node span.
- `invoke_workflow` carries `gen_ai.workflow.name` instead of
  `adk.workflow.name` and `adk.node.path`, and a nested workflow carries
  `gen_ai.workflow.nested`. A workflow given to the `Runner` as its root gets
  one `invoke_workflow` span, opened by the runner.
- `execute_tool` no longer carries `gen_ai.system` or
  `gcp.vertex.agent.invocation_id`. It carries `gen_ai.agent.name`, and its
  `gcp.vertex.agent.event_id` is the id of the function response event the
  agent emits. Under schema v2 the `gcp.vertex.agent.*` content placeholders
  are gone; `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` replace
  them when span content capture is on. Credential secrets are removed from
  tool responses under both schemas.
- `generate_content <model>` no longer sets `error.type`. A span that an error
  escapes from (the root span, `invoke_agent`, `call_llm`, `invoke_node` and a
  nested `invoke_workflow`) records the exception and gets status ERROR, with
  the error type as the status message.

### Identifying attributes

These attributes identify a span rather than describe it, and they are what a
backend filters and groups on.

| Attribute                        | Value                | Set on                                                                       |
| :------------------------------- | :------------------- | :--------------------------------------------------------------------------- |
| `gen_ai.operation.name`          | The step's operation | Every span except `invocation`, `call_llm` and `send_data`                   |
| `gen_ai.conversation.id`         | The session's id     | `invoke_workflow`, `invoke_agent`, `invoke_node`, `generate_content <model>` |
| `gen_ai.system`                  | `'gcp.vertex.agent'` | `call_llm`                                                                   |
| `gcp.vertex.agent.invocation_id` | The invocation's id  | `call_llm`, `generate_content <model>`, `send_data`                          |
| `gcp.vertex.agent.event_id`      | An event's id        | `call_llm`, `generate_content <model>`, both tool spans, `send_data`         |

`gcp.vertex.agent.event_id` is the id of the event the step produced: the model
response event on `call_llm` and `generate_content <model>`, the function
response event on `execute_tool <name>`, and the merged response event on
`execute_tool (merged)`. On `send_data` no event is produced, so the value is a
freshly generated id. The dev server's `/debug/trace/:eventId` route finds a
model response event through `generate_content <model>` under schema v2, and
through `call_llm`, which ends later, under schema v1.

### Descriptive attributes

The rest of the set describes the step.

| Span                     | Attributes                                                                                                                                                                                                                                                                                                                                                                                                                              |
| :----------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_workflow <name>` | `gen_ai.operation.name` `'invoke_workflow'`, `gen_ai.conversation.id`, `gen_ai.workflow.name`, and `gen_ai.workflow.nested` `true` when another workflow span encloses it.                                                                                                                                                                                                                                                              |
| `invoke_agent <name>`    | `gen_ai.operation.name` `'invoke_agent'`, `gen_ai.agent.name`, `gen_ai.agent.description`, `gen_ai.conversation.id` set to the session id.                                                                                                                                                                                                                                                                                              |
| `call_llm` (v1)          | `gen_ai.request.model`, `gcp.vertex.agent.session_id`, `gcp.vertex.agent.llm_request`, `gcp.vertex.agent.llm_response`, and, when present, `gen_ai.request.top_p`, `gen_ai.request.max_tokens`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.response.finish_reasons`.                                                            |
| `execute_tool <name>`    | `gen_ai.operation.name` `'execute_tool'`, `gen_ai.tool.name`, `gen_ai.tool.description`, `gen_ai.tool.type`, `gen_ai.agent.name`, `gen_ai.tool.call.id`. Under v1 also `gcp.vertex.agent.tool_call_args`, `gcp.vertex.agent.tool_response`, and `gcp.vertex.agent.llm_request` and `gcp.vertex.agent.llm_response` both set to `'{}'`. Under v2, with span content capture, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. |
| `execute_tool (merged)`  | `gen_ai.operation.name`, `gen_ai.tool.name` and `gen_ai.tool.description` set to `'(merged tools)'`, `gen_ai.tool.call.id` set to the merged event id. Under v1 also `tool_call_args` set to `'N/A'`, `tool_response` holding the merged function responses, and the `'{}'` placeholders.                                                                                                                                               |
| `send_data`              | `gcp.vertex.agent.data`, the replayed `Content[]` as JSON.                                                                                                                                                                                                                                                                                                                                                                              |
| `invoke_node <name>`     | `gen_ai.operation.name` `'invoke_node'`, `gen_ai.conversation.id`, and `gcp.vertex.agent.associated_event_ids` holding the ids of the events the node emitted, when it emitted any.                                                                                                                                                                                                                                                     |
| `execute_node_attempt`   | `gen_ai.operation.name` `'execute_node'`, `adk.node.path`, `adk.node.run_id`, `adk.node.attempt`, `adk.node.status`, `adk.node.interrupt_count`.                                                                                                                                                                                                                                                                                        |

The empty `llm_request` and `llm_response` on schema v1 tool spans exist because
the dev server's Trace view expects both keys on every span it renders.

Two spans carry only their name. `invoke_agent <name>` gets its attributes on
the `runAsync` path and none under `runLive`, and a function call naming a tool
the agent does not have still opens `execute_tool <name>` so the failure shows
in the waterfall, but writes no attributes on it.

A few values follow rules worth knowing when you query them:

- `gen_ai.tool.type` is the tool's class name, such as `FunctionTool`.
- `gen_ai.tool.call.id` is `'<not specified>'` when the function response
  carries no id.
- `tool_response` and `gen_ai.tool.call.result` are always JSON objects. A tool
  result that is not an object, such as a bare string, is wrapped as
  `{"result": ...}`. Credential secrets, such as tokens, client secrets and API
  keys inside an auth credential or an `adk_request_credential` call, are
  removed first.
- The `call_llm` token counts are the ones `generate_content <model>` carries:
  `gen_ai.usage.output_tokens` includes thought tokens.
- `gen_ai.response.finish_reasons` is a one-element array holding the finish
  reason in lower case, such as `['stop']`.

### What the request payload leaves out

`gcp.vertex.agent.llm_request` is a JSON copy of the request with three things
removed, so that it stays small and holds no credentials:

- `config.responseSchema`, which can be large and is already known to the
  application.
- Every part carrying `inlineData`, so images, audio and other bytes never reach
  the trace.
- `config.httpOptions.headers` and `config.httpOptions.extraBody`, because the
  first commonly carries an `Authorization` token and the second is a free-form
  request body.

### Logs

Each model inference emits OpenTelemetry GenAI log records through the
`@opentelemetry/api-logs` logger named `gcp.vertex.agent` (with schema URL
`https://opentelemetry.io/schemas/1.36.0`), parented to the active
`generate_content <model>` span.

The application owns the `LoggerProvider`. ADK neither creates nor requires a
provider unless you call `maybeSetOtelProviders` with log processors or an OTLP
logs endpoint; when no `LoggerProvider` is registered, log emission is a no-op.

Two semantic-convention schemas are supported through
`ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN`:

| Schema version                       | Event name                                  | When emitted                                                        | Body and attributes                                                                                                                                                                                                                                          |
| :----------------------------------- | :------------------------------------------ | :------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2` or `otel_semconv_1_44` (default) | `gen_ai.client.inference.operation.details` | Once per inference, before the `generate_content <model>` span ends | Empty `body`; `attributes` carry `gen_ai.provider.name`, `gen_ai.agent.name`, `gen_ai.conversation.id`, `gcp.vertex.agent.invocation_id`, `gcp.vertex.agent.event_id`, finish reasons, token usage, `gen_ai.tool.definitions`, and (when captured) messages. |
| `1` or `otel_semconv_1_36`           | `gen_ai.system.message`                     | Once per inference, when `generate_content <model>` starts          | `body`: `{content: <system instruction> \| '<elided>'}`; `attributes`: `{'gen_ai.system': <system>}`.                                                                                                                                                        |
| `1` or `otel_semconv_1_36`           | `gen_ai.user.message`                       | Once per entry in `llmRequest.contents` at span start               | `body`: `{content: <content> \| '<elided>'}`; `attributes`: `{'gen_ai.system': <system>}` plus `'user.id'` when log content capture is enabled.                                                                                                              |
| `1` or `otel_semconv_1_36`           | `gen_ai.choice`                             | Once per recorded model response up to and including `finishReason` | `body`: `{index: 0, content: <content> \| '<elided>', finish_reason?: <reason>}`; `attributes`: `{'gen_ai.system': <system>}`.                                                                                                                               |

Setting `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` forces the
experimental `gen_ai.client.inference.operation.details` record even when
`ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN=1`.

The schema version also selects the span tree, as [Schema
selection](#schema-selection) describes.

You can wire a `LoggerProvider` either through `maybeSetOtelProviders` (or by
setting `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`) or by registering your own
`LoggerProvider` directly:

```ts
import {maybeSetOtelProviders} from '@google/adk';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {BatchLogRecordProcessor} from '@opentelemetry/sdk-logs';

maybeSetOtelProviders([
  {
    logRecordProcessors: [
      new BatchLogRecordProcessor({exporter: new OTLPLogExporter()}),
    ],
  },
]);
```

An application-owned `LoggerProvider` can be registered with
`logs.setGlobalLoggerProvider` before or after the agent is constructed, and
flushed or shut down on exit:

```ts
import {logs} from '@opentelemetry/api-logs';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {detectResources} from '@opentelemetry/resources';
import {BatchLogRecordProcessor, LoggerProvider} from '@opentelemetry/sdk-logs';

const provider = new LoggerProvider({
  resource: detectResources(),
  processors: [new BatchLogRecordProcessor({exporter: new OTLPLogExporter()})],
});
logs.setGlobalLoggerProvider(provider);

// On process exit, flush and shut down the provider:
await provider.shutdown();
```

`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` controls whether prompt,
system instruction, and model output content are included on the
`generate_content <model>` span and on emitted log records. The default is
`NO_CONTENT` so user prompts and model outputs are not exported unless you opt
in:

| Value                       | `generate_content <model>` span content attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`) | Log records                                                                                                                                   |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| `false` or `NO_CONTENT`     | Omitted (default); `gen_ai.tool.definitions` redacts `parameters` to `null`                                                          | `operation.details` omits message attributes and redacts tool `parameters` to `null`; v1 records set `body.content` to `'<elided>'` (default) |
| `true`, `1` or `EVENT_ONLY` | Omitted; `gen_ai.tool.definitions` redacts `parameters` to `null`                                                                    | Emitted with full message content, tool `parameters`, and `user.id`                                                                           |
| `SPAN_ONLY`                 | JSON-serialized on the span (schema v2)                                                                                              | `operation.details` omits message attributes and `user.id`; v1 records set `body.content` to `'<elided>'`                                     |
| `SPAN_AND_EVENT`            | JSON-serialized on the span (schema v2)                                                                                              | Emitted with full message content, tool `parameters`, and `user.id`                                                                           |

`user.id` (from `session.userId`) is attached only to `gen_ai.user.message` and
`gen_ai.client.inference.operation.details` log records, and only when log
content capture is enabled (`EVENT_ONLY` or `SPAN_AND_EVENT`). It is never
written onto spans.

`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` controls what is written to
exported spans and log records. When `WebUiLogProcessor` is registered (as in
`adk web` and `adk api_server`), it reads the unredacted request and response
from the OpenTelemetry emit `Context` for the local `/debug/trace/*` routes
without mutating the record that other processors export.

### Per-run overrides

`RunConfig.telemetry` overrides the telemetry environment variables for one run.
Each field left out falls back to its variable, so two runs in one process can
record differently:

```ts
import {ContentCapturingMode} from '@google/adk';

for await (const event of runner.runAsync({
  userId,
  sessionId,
  newMessage,
  runConfig: {
    telemetry: {captureMessageContent: ContentCapturingMode.EVENT_ONLY},
  },
})) {
  // ...
}
```

| `RunTelemetryConfig` field      | Overrides                                            | Values                                                         |
| :------------------------------ | :--------------------------------------------------- | :------------------------------------------------------------- |
| `genaiSemconvStabilityOptIn`    | `OTEL_SEMCONV_STABILITY_OPT_IN` and the schema default | `'experimental'` or `'stable'`                                 |
| `captureMessageContent`         | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`  | A `ContentCapturingMode` member                                |
| `adkExperimentalTelemetryOptIn` | `ADK_EXPERIMENTAL_TELEMETRY`                          | `true` or `false`                                              |
| `experimentalFeaturesOptIn`     | `ADK_EXPERIMENTAL_TELEMETRY_FEATURES`                 | Feature names; an unknown name is warned about once and dropped |

The first two decide the inference log records and the
`generate_content <model>` span attributes of the run. A per-run
`captureMessageContent` also decides the `gcp.vertex.agent.*` payloads on ADK's
own spans: they carry content only for `SPAN_ONLY` and `SPAN_AND_EVENT`.
Without it, `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` decides. The schema version,
which picks the span tree and the `gen_ai.provider.name` attribute, always comes
from `ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN`.

An operator who must keep the environment in charge sets
`ADK_TELEMETRY_IGNORE_RUN_CONFIG` to `1` or `true`. Every per-run value is then
ignored.

### Log records in the dev server trace view

`AdkApiServer` (used by both `adk web` and `adk api_server`) registers a
`WebUiLogProcessor` alongside its in-memory span processors, whichever way it
exports. It keeps the latest 1000 `gen_ai.client.inference.operation.details`
records. The session trace routes, `/debug/trace/session/:sessionId` and
`/dev/apps/:appName/debug/trace/session/:sessionId`, return each span with its
usual fields and a `logs` list of `{event_name, body, attributes}` for the
records emitted under it. A span without records has an empty list.

The trace view is local, so its copy carries the message content and `user.id`
even when content capture is off for export. The record that other processors
export is not changed. Bytes are base64-encoded with the standard alphabet.

### MCP HTTP exchange records

Each HTTP request and response between an MCP toolset and its server can emit a
DEBUG log record named `adk.experimental.mcp.http.client.response.end`. It
covers the Streamable HTTP and SSE transports, is experimental, and is off by
default.

| Variable                                                    | Effect                                                                                                         |
| :---------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------- |
| `ADK_EXPERIMENTAL_TELEMETRY=true` (or `1`)                  | Turns the record on, with every other experimental feature.                                                    |
| `ADK_EXPERIMENTAL_TELEMETRY_FEATURES=mcp`                   | Turns the record on alone.                                                                                     |
| `ADK_CAPTURE_MCP_HTTP_BODIES=true` (or `1`)                 | Records the request and response bodies, cut at 1000 characters. Otherwise both are `'<elided>'`.              |
| `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST`  | Comma-separated header names or regular expressions, matched whole and case-insensitively, to record.         |
| `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE` | The same, for response headers.                                                                                |

The record's attributes are `http.request.method`, `url.full`,
`http.response.status_code`, `server.address`, `server.port` (when the URL names
a port), `mcp.session.id`, `mcp.protocol.version`, `error.type` (the status
code, when it is 400 or more), and one `http.request.header.<name>` or
`http.response.header.<name>` string array per allowlisted header. Its body is
`{'http.request.body.content', 'http.response.body.content'}`. The record is
parented to the context the request was made in, usually the `execute_tool`
span.

> [!WARNING]
> MCP bodies and headers routinely carry user data and credentials. `url.full`
> drops userinfo and replaces every query value with `REDACTED`, and the values
> of `api-key`, `authorization`, `cookie`, `proxy-authorization`, `set-cookie`,
> `x-api-key` and `x-goog-api-key` are recorded as `<redacted>`. Nothing else is
> redacted: a body, or an allowlisted header with any other name, is exported as
> it is. Only allowlist headers you have checked.

An SSE response body is never read. Any other response body is cloned
synchronously and read in the background when body capture is on, so the
transport receives the response without waiting for the body to buffer. The
record is controlled by the environment only, because the transport has no run
to read a `RunConfig.telemetry` override from, and the switch is read when a
session is created.

## Configuration options

`maybeSetOtelProviders(otelHooksToSetup, otelResource)` takes a list of hooks
and an optional resource.

| Option                          | Type                   | Default                    | Description                          |
| :------------------------------ | :--------------------- | :------------------------- | :----------------------------------- |
| `otelHooksToSetup`              | `OTelHooks[]`          | `[]`                       | Processors and readers to install.   |
| `otelResource`                  | `Resource`             | detected from the environment | Resource attributes on every signal. |
| `OTelHooks.spanProcessors`      | `SpanProcessor[]`      | none                       | Where spans go.                      |
| `OTelHooks.metricReaders`       | `MetricReader[]`       | none                       | Where metrics go.                    |
| `OTelHooks.logRecordProcessors` | `LogRecordProcessor[]` | none                       | Where log records go.                |

Without an `otelResource`, the resource holds `OTEL_SERVICE_NAME` as
`service.name` and each `key=value` pair of `OTEL_RESOURCE_ATTRIBUTES`, and
nothing else.

A provider is created only for a signal that ends up with at least one
processor or reader, so passing span processors alone leaves metrics and logs
alone.

The function does not replace a provider that is already registered globally,
because OpenTelemetry refuses a second global registration. That makes it safe
to call from a library, and it has one consequence worth knowing before you
debug a silent exporter: under `adk web` the dev server registers its own
provider before it loads your agent, so a processor your agent file installs
never receives a span. Read the Trace view in that case.

`maybeSetOtelProviders` also adds an OTLP HTTP exporter per signal when the
matching environment variable is set, so a deployment can turn on export
without a code change.

| Variable                              | Adds                               |
| :------------------------------------ | :--------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | An exporter for all three signals. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | A span exporter.                   |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | A metric reader.                   |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | A log record exporter.             |

### Capturing message content

`ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` decides whether ADK writes payloads onto
its own spans when the run sets no `captureMessageContent`. Content is captured
unless the variable is `false` or `0` (in any case, with surrounding spaces
ignored), which replaces `gcp.vertex.agent.llm_request`,
`gcp.vertex.agent.llm_response`, `gcp.vertex.agent.tool_call_args`,
`gcp.vertex.agent.tool_response` and `gcp.vertex.agent.data` with `'{}'`. The
schema v2 tool attributes `gen_ai.tool.call.arguments` and
`gen_ai.tool.call.result` follow `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`
instead, like the other `gen_ai.*` content attributes.

Those payloads are the user's prompt, the model's answer, and the arguments and
results of each tool call. A trace backend usually sits behind a different
trust boundary from the application, with different retention and a wider
audience, so exporting the content there is a decision to make rather than a
default to accept. The identifying attributes are never redacted, so a
deployment that turns content off keeps its filtering and grouping keys and
loses only the payloads.

## Advanced applications

`getGcpExporters` builds hooks that send spans to Cloud Trace, metrics to Cloud
Monitoring and log records to Cloud Logging, all over OTLP/HTTP through
`telemetry.googleapis.com`, and `getGcpResource` builds the resource that says
where the process runs.

```ts
import {
  getGcpExporters,
  getGcpProjectId,
  getGcpResource,
  maybeSetOtelProviders,
} from '@google/adk';

const projectId = await getGcpProjectId();
const gcpHooks = await getGcpExporters({
  enableTracing: true,
  enableMetrics: true,
  enableLogging: true,
  projectId: projectId ?? undefined,
});
maybeSetOtelProviders([gcpHooks], getGcpResource(projectId));
```

| `OtelExportersConfig` field | Default                  | Effect in `getGcpExporters`                                                                       |
| :-------------------------- | :----------------------- | :------------------------------------------------------------------------------------------------ |
| `enableTracing`             | `false`                  | Adds a batched span processor that exports to `https://telemetry.googleapis.com/v1/traces`.       |
| `enableMetrics`             | `false`                  | Adds a metric reader that exports to `https://telemetry.googleapis.com/v1/metrics` every 5000 ms. |
| `enableLogging`             | `false`                  | Adds a batched log record processor that exports to Cloud Logging.                                |
| `projectId`                 | resolved via credentials | Skips looking up the project a second time when already resolved.                                 |

Every request is authenticated with Application Default Credentials and the
`https://www.googleapis.com/auth/cloud-platform` scope. A failed credential
lookup logs a warning without the error text, and the request goes out without
an `Authorization` header. The endpoint takes the project from the
`gcp.project_id` resource attribute, which `getGcpResource` sets, so pass that
resource to `maybeSetOtelProviders` as the example does. The mTLS endpoint
selection described under [Cloud Logging](#cloud-logging) applies to all three
signals, with `https://telemetry.mtls.googleapis.com/v1/traces` and
`/v1/metrics` as the mTLS endpoints.

`getGcpExporters` resolves the project through the ambient Google credentials
when `projectId` is not provided. When no project resolves, it logs a warning
and returns empty hooks, so a process without credentials starts and runs
untraced rather than failing.

`adk web --otel_to_cloud` and `adk api_server --otel_to_cloud` turn on all three
signals and use `getGcpResource` with the credentials' project.

### Cloud Logging

With `enableLogging`, every log record that reaches the provider is exported
over OTLP/HTTP to `https://telemetry.googleapis.com/v1/logs`. Each request is
authenticated with Application Default Credentials and the
`https://www.googleapis.com/auth/cloud-platform` scope, with a token refreshed
as needed. The exporter works on its own copy of each record, so other
processors see the record unchanged. On that copy:

- `event.name` is set from the record's event name, unless the record sets it.
- `gcp.log_name` defaults to `GCP_DEFAULT_LOG_NAME`, or failing that to
  `adk-otel`, or on Agent Engine to
  `aiplatform.googleapis.com/reasoning_engine_stdout`. Cloud Logging files a
  record in the log its event name names, and uses `gcp.log_name` for a record
  without one.
- `service.version` is copied from the resource into an attribute, because
  Cloud Logging drops resource attributes it maps to a monitored resource.

On Agent Engine, which `GOOGLE_CLOUD_AGENT_ENGINE_ID` marks, the copy also:

- loses its event name, which Cloud Logging would otherwise use as the log name,
  splitting the records over one log per event type;
- gains the resource attributes `gcp.resource_type`
  (`aiplatform.googleapis.com/ReasoningEngine`), `location`
  (`GOOGLE_CLOUD_AGENT_ENGINE_LOCATION`, else `GOOGLE_CLOUD_LOCATION`),
  `reasoning_engine_id` and `resource_container` (`projects/<project ID>`).
  These go on exported log records only, never on the resource that traces and
  metrics share.

On Agent Engine the credentials may name the project by number. Both
`getGcpProjectId` and `getGcpExporters` look up the project ID in Cloud Resource
Manager (`resourcemanager.projects.get`, included in roles such as
`roles/viewer` and `roles/browser`), and a failed lookup keeps the number.

`GOOGLE_API_USE_CLIENT_CERTIFICATE=true` turns on the mTLS endpoint selection,
`https://telemetry.mtls.googleapis.com/v1/logs`. `GOOGLE_API_USE_MTLS_ENDPOINT`
then picks the endpoint: `always` the mTLS one, `never` the plain one, and
`auto` (the default, and the fallback for an unknown value, which is warned
about) the plain one, because no client certificate source is discovered yet.

### The resource

`getGcpResource(projectId?)` layers these sources, later ones winning:

1. `service.instance.id`, unique per process, and `gcp.project_id` and
   `cloud.account.id` from `projectId`, or `GOOGLE_CLOUD_PROJECT` when
   `projectId` is omitted (warned about when neither is set).
2. On Agent Engine: `cloud.provider`, `cloud.platform` (`gcp.agent_engine`),
   `service.name` (the engine id), `service.version`
   (`GOOGLE_CLOUD_AGENT_ENGINE_RUNTIME_REVISION_ID`), `cloud.region`,
   `cloud.resource_id` and the `telemetry.sdk.*` attributes.
3. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`.
4. The GCP resource detector (GKE, Cloud Run, Cloud Functions, App Engine, GCE),
   skipped on Agent Engine.
5. `gen_ai.main_agent.id`, the Agent Registry URN of the agent on Agent Engine,
   GKE and Cloud Run, unless a source above already set it. It needs the
   project number from Cloud Resource Manager (`resourcemanager.projects.get`)
   and a zone or region. On GKE the namespace and Deployment come from
   `k8s.namespace.name` and `k8s.deployment.name`, or else from the pod's
   service account and `HOSTNAME`.

The detector and the URN settle asynchronously; the SDK's processors wait for
them before they export.

## Limitations

`core/src/telemetry/tracing.ts` is not exported from `@google/adk`, apart from
`ContentCapturingMode`, so `tracer`, `traceCallLlm`, `traceToolCall` and the
other trace functions cannot be imported. The framework calls them where it
opens each span, and the attributes rather than the functions are the contract a
caller observes. adk-python differs here: `google.adk.telemetry` is importable.

A trace call never throws. A payload that `JSON.stringify` rejects, such as one
holding a cycle, is recorded as `'<not serializable>'`, so an unserializable
tool result costs one attribute rather than the run. A trace call made with no
active span does nothing.

`maybeSetOtelProviders` is marked experimental in its documentation, so its
signature may change.

Export to `telemetry.googleapis.com` has these gaps, for traces, metrics and
logs alike:

- The OTLP exporters in `core` send JSON, not protobuf.
- No default client certificate source is discovered, so
  `GOOGLE_API_USE_MTLS_ENDPOINT=auto` always picks the plain endpoint, and
  `always` picks the mTLS endpoint without configuring a client certificate.
- The OTLP exporter sends its own `User-Agent`,
  `OTel-OTLP-Exporter-JavaScript/<version>`, on every request. No Agent Engine
  SDK version is available in JavaScript, so
  `GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY` adds no `Vertex-Agent-Engine`
  token.

The MCP HTTP exchange record lists only the request headers the transport passes
to `fetch`, not ones the HTTP client adds on the wire. Its switch is read when a
session is created, so a change takes effect with the next session.

## Related samples

- [`samples/telemetry/`](../../../samples/telemetry/README.md) - One traced tool call, with its span attributes printed to the console.
