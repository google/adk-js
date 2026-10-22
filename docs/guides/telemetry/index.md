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
`OTelHooks` and `OtelExportersConfig` types, `getGcpExporters` and
`getGcpResource`. The functions that write the attributes are called by the
framework, and [Limitations](#limitations) explains why they are not exported.

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

ADK names each span after the step it covers. A prompt that triggers one tool
call produces `invocation`, `invoke_agent <name>`, `call_llm`,
`execute_tool <name>` and a second `call_llm`: the first model call returns the
tool call, and the second turns the tool response into the answer.

| Span                       | Opened for                                                         |
| :------------------------- | :----------------------------------------------------------------- |
| `invocation`               | One turn, opened by the `Runner`.                                  |
| `invoke_agent <name>`      | One agent's part of the turn.                                      |
| `call_llm`                 | One request to the model.                                          |
| `generate_content <model>` | One model inference inside `call_llm` (OpenTelemetry GenAI span).  |
| `execute_tool <name>`      | One tool call and its response.                                    |
| `execute_tool (merged)`    | Parallel tool calls whose responses are merged into one event.     |
| `send_data`                | Replaying session history to a live model connection in `runLive`. |
| `invoke_workflow <name>`   | One `Workflow` run.                                                |
| `execute_node <name>`      | One node in a workflow.                                            |

### Identifying attributes

Three attributes identify a span rather than describe it, and they are what a
backend filters and groups on.

| Attribute                        | Value                | Set on                                                     |
| :------------------------------- | :------------------- | :--------------------------------------------------------- |
| `gen_ai.system`                  | `'gcp.vertex.agent'` | `call_llm`, `execute_tool <name>`, `execute_tool (merged)` |
| `gcp.vertex.agent.invocation_id` | The invocation's id  | `call_llm`, both tool spans, `send_data`                   |
| `gcp.vertex.agent.event_id`      | An event's id        | `call_llm`, both tool spans, `send_data`                   |

`gen_ai.system` is the OpenTelemetry semantic-convention key that marks a span
as belonging to a Generative AI system. Because ADK writes the same value on the
model spans and the tool spans, one filter on that key selects every model call
and every tool call of a run. `gcp.vertex.agent.invocation_id` carries one value
across a turn, so grouping by it collects that turn's model and tool calls
together.

`gcp.vertex.agent.event_id` is the id of the event the step produced: the model
response event on `call_llm`, the function response event on
`execute_tool <name>`, and the merged response event on `execute_tool (merged)`.
On `send_data` no event is produced, so the value is a freshly generated id.

### Descriptive attributes

The rest of the set describes the step.

| Span                    | Attributes                                                                                                                                                                                                                                                                                                        |
| :---------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_agent <name>`   | `gen_ai.operation.name` `'invoke_agent'`, `gen_ai.agent.name`, `gen_ai.agent.description`, `gen_ai.conversation.id` set to the session id.                                                                                                                                                                        |
| `call_llm`              | `gen_ai.request.model`, `gen_ai.agent.name`, `gcp.vertex.agent.session_id`, `gcp.vertex.agent.llm_request`, `gcp.vertex.agent.llm_response`, and, when present, `gen_ai.request.top_p`, `gen_ai.request.max_tokens`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`. |
| `execute_tool <name>`   | `gen_ai.operation.name` `'execute_tool'`, `gen_ai.tool.name`, `gen_ai.tool.description`, `gen_ai.tool.type`, `gen_ai.tool.call.id`, `gcp.vertex.agent.tool_call_args`, `gcp.vertex.agent.tool_response`, and `gcp.vertex.agent.llm_request` and `gcp.vertex.agent.llm_response` both set to `'{}'`.               |
| `execute_tool (merged)` | The same keys, with `gen_ai.tool.name` and `gen_ai.tool.description` set to `'(merged tools)'`, `gen_ai.tool.call.id` set to the merged event id, `tool_call_args` set to `'N/A'`, and `tool_response` holding the whole merged event.                                                                            |
| `send_data`             | `gcp.vertex.agent.data`, the replayed `Content[]` as JSON.                                                                                                                                                                                                                                                        |
| `invoke_workflow`       | `gen_ai.operation.name` `'invoke_workflow'`, `gen_ai.conversation.id`, `adk.workflow.name`, `adk.node.path`.                                                                                                                                                                                                      |
| `execute_node`          | `gen_ai.operation.name` `'execute_node'`, `adk.node.path`, `adk.node.run_id`, `adk.node.attempt`, `adk.node.status`, `adk.node.interrupt_count`.                                                                                                                                                                  |

The empty `llm_request` and `llm_response` on tool spans exist because the dev
server's Trace view expects both keys on every span it renders.

Two spans carry only their name. `invoke_agent <name>` gets its attributes on
the `runAsync` path and none under `runLive`, and a function call naming a tool
the agent does not have still opens `execute_tool <name>` so the failure shows
in the waterfall, but writes no attributes on it.

A few values follow rules worth knowing when you query them:

- `gen_ai.tool.type` is the tool's class name, such as `FunctionTool`.
- `gen_ai.tool.call.id` is `'<not specified>'` when the function response
  carries no id.
- `tool_response` is always a JSON object. A tool result that is not an object,
  such as a bare string, is wrapped as `{"result": ...}`.
- `gen_ai.usage.input_tokens` is written whenever the response has usage
  metadata, as `0` if the prompt token count is missing, while
  `gen_ai.usage.output_tokens` is written only for a non-zero count.
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

The schema version selects the log records and the `generate_content <model>`
span attributes only. The surrounding span tree has not moved to schema v2 yet:
`invocation` and `call_llm` remain unchanged, and `generate_content <model>` is
parented under `call_llm`.

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

## Configuration options

`maybeSetOtelProviders(otelHooksToSetup, otelResource)` takes a list of hooks
and an optional resource.

| Option                          | Type                   | Default                    | Description                          |
| :------------------------------ | :--------------------- | :------------------------- | :----------------------------------- |
| `otelHooksToSetup`              | `OTelHooks[]`          | `[]`                       | Processors and readers to install.   |
| `otelResource`                  | `Resource`             | an empty detected resource | Resource attributes on every signal. |
| `OTelHooks.spanProcessors`      | `SpanProcessor[]`      | none                       | Where spans go.                      |
| `OTelHooks.metricReaders`       | `MetricReader[]`       | none                       | Where metrics go.                    |
| `OTelHooks.logRecordProcessors` | `LogRecordProcessor[]` | none                       | Where log records go.                |

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
spans. Content is captured when the variable is unset, empty, `true` or `1`.
Any other value, such as `false`, `0` or `no`, replaces
`gcp.vertex.agent.llm_request`, `gcp.vertex.agent.llm_response`,
`gcp.vertex.agent.tool_call_args`, `gcp.vertex.agent.tool_response` and
`gcp.vertex.agent.data` with `'{}'`.

Those payloads are the user's prompt, the model's answer, and the arguments and
results of each tool call. A trace backend usually sits behind a different
trust boundary from the application, with different retention and a wider
audience, so exporting the content there is a decision to make rather than a
default to accept. The identifying attributes are never redacted, so a
deployment that turns content off keeps its filtering and grouping keys and
loses only the payloads.

## Advanced applications

`getGcpExporters` builds hooks that send spans to Cloud Trace and metrics to
Cloud Monitoring, and `getGcpResource` detects the Google Cloud resource labels
that say where the process runs.

```ts
import {
  getGcpExporters,
  getGcpResource,
  maybeSetOtelProviders,
} from '@google/adk';

const gcpHooks = await getGcpExporters({
  enableTracing: true,
  enableMetrics: true,
});
maybeSetOtelProviders([gcpHooks], getGcpResource());
```

| `OtelExportersConfig` field | Default | Effect in `getGcpExporters`                            |
| :-------------------------- | :------ | :----------------------------------------------------- |
| `enableTracing`             | `false` | Adds a batched Cloud Trace span processor.             |
| `enableMetrics`             | `false` | Adds a Cloud Monitoring reader that exports every 5 s. |
| `enableLogging`             | `false` | Ignored. No Cloud Logging exporter is created.         |

`getGcpExporters({enableLogging: true})` still creates no Cloud Logging
exporter; to export ADK's GenAI log records, use the OTLP log exporter path via
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` or pass `logRecordProcessors` to
`maybeSetOtelProviders` as shown in [Logs](#logs).

`getGcpExporters` resolves the project through the ambient Google credentials.
When no project resolves, it logs a warning and returns empty hooks, so a
process without credentials starts and runs untraced rather than failing.

## Limitations

`core/src/telemetry/tracing.ts` is not exported from `@google/adk`, so `tracer`,
`traceCallLlm`, `traceToolCall` and the other trace functions cannot be
imported. The framework calls them where it opens each span, and the attributes
rather than the functions are the contract a caller observes. adk-python differs
here: `google.adk.telemetry` is importable.

`getGcpExporters` loads each exporter from an optional peer dependency when you
enable its signal. Install the one you use:

```bash
npm install @google-cloud/opentelemetry-cloud-trace-exporter
npm install @google-cloud/opentelemetry-cloud-monitoring-exporter
```

A trace call never throws. A payload that `JSON.stringify` rejects, such as one
holding a cycle, is recorded as `'<not serializable>'`, so an unserializable
tool result costs one attribute rather than the run. A trace call made with no
active span does nothing.

`maybeSetOtelProviders` is marked experimental in its documentation, so its
signature may change.

## Related samples

- [`samples/telemetry/`](../../../samples/telemetry/README.md) - One traced tool call, with its span attributes printed to the console.
