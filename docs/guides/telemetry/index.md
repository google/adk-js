# Telemetry

ADK opens an OpenTelemetry span for each step of a run, writes what the
framework knows about that step onto it as attributes, and emits one log record
for each model call. `maybeSetOtelProviders` is the call that sends those
spans, log records and metrics to an exporter you choose.

## Introduction

A run reaches a trace backend as a tree of spans: the turn, each agent and
workflow in it, each model call, and each tool call. The OpenTelemetry SDK
records timing and parentage on its own. It cannot know the framework context
around each step, so ADK adds it: which session and invocation the span belongs
to, which agent, model and tool, and how many tokens the model used.

The span and attribute names follow the OpenTelemetry semantic conventions for
Generative AI (version 1.44). A backend that understands those conventions can
show an ADK trace without configuration, and the `adk web` dev server reads the
same attributes to render its Trace view.

Everything a caller imports is in `@google/adk`: `maybeSetOtelProviders`, the
`OTelHooks` and `OtelExportersConfig` types, `getGcpExporters` and
`getGcpResource`. The functions that write the attributes are called by the
framework, and [Limitations](#limitations) explains why they are not exported.

## Get started

Install a span processor and a log record processor once, before the agent
runs, and everything ADK emits afterwards goes through them. This example
prints each span and log record to the console, which shows the full attribute
set without a backend.

```ts
import {FunctionTool, LlmAgent, maybeSetOtelProviders} from '@google/adk';
import {
  ConsoleLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {z} from 'zod';

maybeSetOtelProviders([
  {
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
    logRecordProcessors: [
      new SimpleLogRecordProcessor({exporter: new ConsoleLogRecordExporter()}),
    ],
  },
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
a network exporter wants. The same holds for the log record processors.

## How it works

ADK names each span after the step it covers. A prompt that triggers one tool
call produces this tree:

```text
invoke_workflow order_assistant
└── invoke_agent order_assistant
    ├── generate_content gemini-flash-latest   (one log record)
    ├── execute_tool get_order_status
    └── generate_content gemini-flash-latest   (one log record)
```

The first model call returns the tool call, and the second turns the tool
response into the answer. The tool span is a sibling of the model calls, not a
child: a `generate_content` span ends at the response that reports why the model
stopped, before the agent acts on that response.

| Span                                 | Opened for                                                                                     |
| :----------------------------------- | :--------------------------------------------------------------------------------------------- |
| `invoke_workflow <name>`             | One turn, opened by the `Runner` and named after its root agent or workflow. Also each nested `Workflow` run, and the turn of an agent called through `AgentTool`. |
| `invoke_agent <name>`                | One agent's part of the turn.                                                                  |
| `generate_content <model>`           | One call to the model. None is opened when a `beforeModelCallback` answers instead.            |
| `execute_tool <name>`                | One tool call and its response.                                                                |
| `execute_tool <name> <skill> [path]` | A skill tool call, named after the skill and the resource or script it touched.                |
| `execute_tool (merged)`              | Parallel tool calls whose responses are merged into one event.                                 |
| `invoke_node <name>`                 | One plain node in a workflow. An agent or workflow node is traced by its own span instead.     |
| `compact_events <trigger>`           | One context compaction.                                                                        |
| `send_data`                          | Replaying session history to a live model connection in `runLive`.                             |

A workflow passed to the `Runner` as its root runs inside the turn's
`invoke_workflow` span rather than opening a second one. Any other workflow
span below it carries `gen_ai.workflow.nested = true`.

### Span attributes

| Span                       | Attributes                                                                                                                                                                                                                                                                                                                                                                                |
| :------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_workflow <name>`   | `gen_ai.operation.name`, `gen_ai.conversation.id` (the session id), `gen_ai.workflow.name`, and `gen_ai.workflow.nested` on a nested workflow.                                                                                                                                                                                                                                         |
| `invoke_agent <name>`      | `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.agent.description`, `gen_ai.conversation.id`.                                                                                                                                                                                                                                                                                    |
| `generate_content <model>` | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.agent.name`, `gen_ai.conversation.id`, `gen_ai.provider.name`, `gcp.vertex.agent.event_id`, `gcp.vertex.agent.invocation_id`, `gen_ai.tool.definitions`, and when known `gen_ai.request.top_p`, `gen_ai.request.max_tokens`, `gen_ai.response.finish_reasons` and the `gen_ai.usage.*` token counts. Message content is described below. |
| `execute_tool <name>`      | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.description`, `gen_ai.tool.type`, `gen_ai.agent.name`, `gen_ai.tool.call.id`, `gcp.vertex.agent.event_id`, and `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` when content capture includes spans. A skill tool adds `gen_ai.skill.name`, `gen_ai.skill.description`, `gen_ai.skill.resource.name` and `adk.skill.additional_tools`. |
| `execute_tool (merged)`    | `gen_ai.operation.name`, `gen_ai.tool.name` and `gen_ai.tool.description` set to `'(merged tools)'`, and `gen_ai.tool.call.id` and `gcp.vertex.agent.event_id` set to the merged event id.                                                                                                                                                                                              |
| `invoke_node <name>`       | `gen_ai.operation.name`, `gen_ai.conversation.id`, and `gcp.vertex.agent.associated_event_ids`, the ids of the events the node emitted.                                                                                                                                                                                                                                                 |
| `compact_events <trigger>` | `gen_ai.operation.name`, `gen_ai.conversation.id`, `gen_ai.compaction.trigger`, and for a compaction that added a summary `gen_ai.compaction.result_event_id`, `gen_ai.compaction.event_count`, `gen_ai.compaction.start_timestamp` and `gen_ai.compaction.end_timestamp`.                                                                                                             |
| `send_data`                | `gcp.vertex.agent.invocation_id`, `gcp.vertex.agent.event_id`, and `gcp.vertex.agent.data`, the replayed `Content[]` as JSON.                                                                                                                                                                                                                                                          |

A few values follow rules worth knowing when you query them:

- `gen_ai.provider.name` is `gcp.gemini`, or `gcp.vertex_ai` when
  `GOOGLE_GENAI_USE_ENTERPRISE` (or the older `GOOGLE_GENAI_USE_VERTEXAI`) is
  set. A model id of the form `<provider>/<model>` reports its provider.
- `gen_ai.usage.input_tokens` adds the prompt tokens and the tokens of
  server-side tool results. `gen_ai.usage.output_tokens` adds the candidate and
  reasoning tokens. A count the model did not report is left out.
- `gen_ai.response.finish_reasons` is a one-element array holding the finish
  reason in lower case, such as `['stop']`.
- `gen_ai.tool.type` is the tool's class name, such as `FunctionTool`.
- A failure sets the span status to ERROR. A tool span also gets `error.type`,
  for an error the tool throws and for one it reports in its response through
  an `errorType` or `error_code` field. The status message is the error type,
  never the error text.

### The model call log record

Each model call emits one log record with the event name
`gen_ai.client.inference.operation.details`, while its `generate_content` span
is still open, so the record carries that span's trace and span ids. Its body is
empty; the details are attributes:

- the span's `gen_ai.agent.name`, `gen_ai.conversation.id`,
  `gen_ai.provider.name`, `gcp.vertex.agent.event_id` and
  `gcp.vertex.agent.invocation_id`;
- `gen_ai.response.finish_reasons` and the `gen_ai.usage.*` token counts;
- `gen_ai.tool.definitions`;
- when content capture includes events, `gen_ai.input.messages`,
  `gen_ai.system_instructions`, `gen_ai.output.messages` and `user.id`.

Exactly one record is emitted per call, also when the call fails or the caller
stops reading the response stream early.

### Capturing message content

`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` decides where message
content goes. The value is read case-insensitively when each step starts.

| Value                         | Content on the log record | Content on spans |
| :---------------------------- | :------------------------ | :--------------- |
| unset, `NO_CONTENT`, or other | no                        | no               |
| `EVENT_ONLY`, `true`, `1`     | yes                       | no               |
| `SPAN_ONLY`                   | no                        | yes              |
| `SPAN_AND_EVENT`              | yes                       | yes              |

Message content is the user's prompt, the system instruction, the model's
answer, the tool parameter schemas inside `gen_ai.tool.definitions`, and the
arguments and result of each tool call. Without content capture
`gen_ai.tool.definitions` still lists each tool's name and description. The
`user.id` of the session is personal data too, so it goes only on the log record
and only when content capture includes events; it is never set on a span.

ADK keeps a few things out even when content is captured: the bytes of inline
data parts (only the MIME type is recorded), and the secret fields of anything
shaped like an auth credential in a tool result.

A trace or log backend usually sits behind a different trust boundary from the
application, with different retention and a wider audience, so exporting the
content there is a decision to make rather than a default to accept.

### Experimental telemetry

Some attributes are experimental and may change. `ADK_EXPERIMENTAL_TELEMETRY`
set to `true` or `1` turns all of them on, and
`ADK_EXPERIMENTAL_TELEMETRY_FEATURES` turns on the features it names, as a
comma-separated list of `skills`, `workflow`, `context_cache`, `grounding`,
`mcp`, `token_usage` and `compaction`. In this release the `grounding` feature
adds `adk.experimental.grounding.*` attributes to a `generate_content` span
whose response used a built-in grounding tool.

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

### Sending log records

ADK writes its log records through the global `LoggerProvider` of the
OpenTelemetry Logs API. The application owns that provider: ADK never creates
one, and it looks the provider up when it emits each record, so a provider
registered after ADK is imported still receives every record. A run with no
provider registered emits nothing.

One way to register the provider is `maybeSetOtelProviders`, with log record
processors in its hooks or with `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (or
`OTEL_EXPORTER_OTLP_ENDPOINT`) set:

```ts
import {maybeSetOtelProviders} from '@google/adk';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {BatchLogRecordProcessor} from '@opentelemetry/sdk-logs';

maybeSetOtelProviders([
  {logRecordProcessors: [new BatchLogRecordProcessor({exporter: new OTLPLogExporter()})]},
]);
```

The other is to create the provider yourself and register it with the Logs
API:

```ts
import {logs} from '@opentelemetry/api-logs';
import {
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';

const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({exporter: new ConsoleLogRecordExporter()})],
});
logs.setGlobalLoggerProvider(loggerProvider);
```

ADK's records use the instrumentation scope `gcp.vertex.agent`, with the ADK
version and the schema URL `https://opentelemetry.io/schemas/1.44.0`.

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

`getGcpExporters` resolves the project through the ambient Google credentials.
When no project resolves, it logs a warning and returns empty hooks, so a
process without credentials starts and runs untraced rather than failing.

## Limitations

`core/src/telemetry/api/instrumentation.ts` is not exported from `@google/adk`,
so `recordInference`, `recordToolExecution` and the other scope functions cannot
be imported. The framework calls them where it opens each span, and the
attributes rather than the functions are the contract a caller observes.

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

- [`samples/telemetry/`](../../../samples/telemetry/README.md) - One traced tool call, with its spans and log records printed to the console.
