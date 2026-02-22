# Telemetry

ADK-JS integrates with OpenTelemetry to provide comprehensive observability for agent applications. The framework automatically instruments agent invocations, LLM calls, and tool executions with distributed tracing.

## Overview

The telemetry system records:
- Agent invocations with full context
- LLM requests and responses
- Tool executions with arguments and results
- Session and event tracking
- Token usage metrics

All telemetry follows OpenTelemetry semantic conventions for generative AI systems.

## Tracer Setup

ADK-JS uses a global tracer with the service name `gcp.vertex.agent`:

```typescript
import {trace} from '@opentelemetry/api';
import {version} from '@google/adk';

export const tracer = trace.getTracer('gcp.vertex.agent', version);
```

The tracer is available from `@google/adk`:

```typescript
import {tracer} from '@google/adk';
```

## Configuring OpenTelemetry

### OTelHooks Interface

The `OTelHooks` interface allows you to configure OpenTelemetry components:

```typescript
interface OTelHooks {
  spanProcessors?: SpanProcessor[];
  metricReaders?: MetricReader[];
  logRecordProcessors?: LogRecordProcessor[];
}
```

### Setting Up Providers

Use `maybeSetOtelProviders()` to configure OpenTelemetry providers:

```typescript
import {maybeSetOtelProviders, OTelHooks} from '@google/adk';

const hooks: OTelHooks = {
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter())
  ],
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter()
    })
  ]
};

maybeSetOtelProviders([hooks]);
```

This function will not override providers that are already globally set.

### OTLP Environment Variables

ADK-JS automatically configures OTLP exporters based on environment variables:

| Environment Variable | Purpose |
|---------------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint for all signals |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Traces-specific endpoint |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Metrics-specific endpoint |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Logs-specific endpoint |

Additional standard OpenTelemetry environment variables:

| Environment Variable | Purpose |
|---------------------|---------|
| `OTEL_SERVICE_NAME` | Service name for resource detection |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional resource attributes (key-value pairs) |

When any OTLP endpoint is set, ADK-JS automatically creates the appropriate exporters.

## Google Cloud Exporters

ADK-JS provides built-in support for Google Cloud's Cloud Trace and Cloud Monitoring exporters.

### getGcpExporters()

Export telemetry to Google Cloud:

```typescript
import {getGcpExporters, maybeSetOtelProviders} from '@google/adk';

const gcpExporters = await getGcpExporters({
  enableTracing: true,
  enableMetrics: true,
  enableLogging: false
});

maybeSetOtelProviders([gcpExporters]);
```

**Configuration options:**

```typescript
interface OtelExportersConfig {
  enableTracing?: boolean;   // Export traces to Cloud Trace
  enableMetrics?: boolean;    // Export metrics to Cloud Monitoring
  enableLogging?: boolean;    // Export logs to Cloud Logging
}
```

The function automatically detects the GCP project ID using Application Default Credentials (ADC). If no project can be determined, it logs a warning and returns empty hooks.

### getGcpResource()

Create a resource with GCP-specific attributes:

```typescript
import {getGcpResource, maybeSetOtelProviders} from '@google/adk';

const resource = getGcpResource();
const hooks = await getGcpExporters({enableTracing: true});

maybeSetOtelProviders([hooks], resource);
```

This function uses the `@opentelemetry/resource-detector-gcp` package to detect GCP environment attributes like project ID, instance ID, and zone.

## Span Attributes

ADK-JS records detailed attributes on each span following OpenTelemetry semantic conventions for generative AI.

### Agent Invocation Spans

When an agent is invoked, the following attributes are set:

| Attribute | Description |
|-----------|-------------|
| `gen_ai.operation.name` | Always set to `"invoke_agent"` |
| `gen_ai.agent.name` | Agent name |
| `gen_ai.agent.description` | Agent description |
| `gen_ai.conversation.id` | Session ID |

Example:
```typescript
{
  "gen_ai.operation.name": "invoke_agent",
  "gen_ai.agent.name": "customer_support_agent",
  "gen_ai.agent.description": "Helps customers with support requests",
  "gen_ai.conversation.id": "session_abc123"
}
```

### LLM Call Spans

When an LLM is called, these attributes are recorded:

| Attribute | Description |
|-----------|-------------|
| `gen_ai.system` | Always set to `"gcp.vertex.agent"` |
| `gen_ai.operation.name` | Always set to `"call_llm"` |
| `gen_ai.request.model` | Model name (e.g., "gemini-2.5-flash") |
| `gen_ai.request.top_p` | Top-p sampling parameter (if set) |
| `gen_ai.request.max_tokens` | Max output tokens (if set) |
| `gen_ai.usage.input_tokens` | Prompt token count |
| `gen_ai.usage.output_tokens` | Response token count |
| `gen_ai.response.finish_reasons` | Array of finish reason(s) |
| `gcp.vertex.agent.invocation_id` | Unique invocation ID |
| `gcp.vertex.agent.session_id` | Session ID |
| `gcp.vertex.agent.event_id` | Event ID |
| `gcp.vertex.agent.llm_request` | Serialized LLM request (see `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`) |
| `gcp.vertex.agent.llm_response` | Serialized LLM response (see `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`) |

### Tool Execution Spans

When a tool is executed, these attributes are set:

| Attribute | Description |
|-----------|-------------|
| `gen_ai.operation.name` | Always set to `"execute_tool"` |
| `gen_ai.tool.name` | Tool name |
| `gen_ai.tool.description` | Tool description |
| `gen_ai.tool.type` | Tool class name (e.g., "FunctionTool") |
| `gen_ai.tool.call.id` | Function call ID |
| `gcp.vertex.agent.event_id` | Event ID |
| `gcp.vertex.agent.tool_call_args` | Serialized tool arguments (see `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`) |
| `gcp.vertex.agent.tool_response` | Serialized tool response (see `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`) |

### Data Send Spans

When data is sent to an agent:

| Attribute | Description |
|-----------|-------------|
| `gen_ai.operation.name` | Always set to `"send_data"` |
| `gcp.vertex.agent.invocation_id` | Invocation ID |
| `gcp.vertex.agent.event_id` | Event ID |
| `gcp.vertex.agent.data` | Serialized content data (see `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`) |

## ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS

The `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` environment variable controls whether request/response content is included in OpenTelemetry spans.

**Default:** `true` (for backward compatibility)

**Valid values:**
- `"true"` or `"1"` - Include full request/response content in spans
- `"false"` or `"0"` - Exclude content, only record metadata

When disabled, the following attributes are set to empty JSON objects (`"{}"`) instead of full content:
- `gcp.vertex.agent.llm_request`
- `gcp.vertex.agent.llm_response`
- `gcp.vertex.agent.tool_call_args`
- `gcp.vertex.agent.tool_response`
- `gcp.vertex.agent.data`

**Example:**

```bash
# Disable content capture for privacy/compliance
export ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false
```

**Use cases for disabling:**
- Compliance requirements (GDPR, HIPAA, etc.)
- Reducing trace payload size
- Avoiding sensitive data in telemetry backends
- Performance optimization for high-volume applications

## Context Propagation

ADK-JS ensures proper OpenTelemetry context propagation across async boundaries.

### Async Generator Context Binding

The `runAsyncGeneratorWithOtelContext()` utility binds OpenTelemetry context to async generators:

```typescript
import {context} from '@opentelemetry/api';
import {runAsyncGeneratorWithOtelContext} from '@google/adk';

async function* myGenerator() {
  // This generator will maintain OTel context
  yield 1;
  yield 2;
}

const otelContext = context.active();
const boundGenerator = runAsyncGeneratorWithOtelContext(
  otelContext,
  this,
  myGenerator
);

for await (const value of boundGenerator) {
  // Context is preserved across yields
  console.log(value);
}
```

This is used internally to maintain trace context throughout agent execution pipelines.

## Tracing Functions

ADK-JS provides several functions to manually record trace information:

### traceAgentInvocation()

```typescript
import {traceAgentInvocation} from '@google/adk';

traceAgentInvocation({
  agent: myAgent,
  invocationContext: context
});
```

### traceCallLlm()

```typescript
import {traceCallLlm} from '@google/adk';

traceCallLlm({
  invocationContext: context,
  eventId: 'event_123',
  llmRequest: request,
  llmResponse: response
});
```

### traceToolCall()

```typescript
import {traceToolCall} from '@google/adk';

traceToolCall({
  tool: myTool,
  args: {param1: 'value1'},
  functionResponseEvent: event
});
```

### traceSendData()

```typescript
import {traceSendData} from '@google/adk';

traceSendData({
  invocationContext: context,
  eventId: 'event_123',
  data: [content]
});
```

These functions check for an active span and only record attributes if one exists. They are called automatically by the framework during agent execution.

## Dev Server Telemetry

The ADK development server provides built-in telemetry collection for debugging.

### Internal Exporters

The dev server uses two internal exporters:

1. **ApiServerSpanExporter** - Captures spans for the `/debug/trace/:eventId` endpoint
2. **InMemoryExporter** - Stores all spans for session-based trace queries

These exporters run alongside any user-configured exporters.

### Debug Endpoints

**Get trace for specific event:**
```
GET /debug/trace/:eventId
```

Returns span attributes for a specific event ID.

**Get all traces for session:**
```
GET /debug/trace/session/:sessionId
```

Returns an array of all spans for a session with:
- `name` - Span name
- `span_id` - Span ID
- `trace_id` - Trace ID
- `start_time` - Start time in nanoseconds
- `end_time` - End time in nanoseconds
- `attributes` - All span attributes
- `parent_span_id` - Parent span ID (or null)

### CLI Telemetry Options

Both `web` and `api_server` commands support telemetry configuration:

```bash
# Send telemetry to Google Cloud
npx @google/adk-devtools web --otel_to_cloud true

# Use OTLP environment variables
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
npx @google/adk-devtools web
```

## Complete Example

```typescript
import {
  LlmAgent,
  InMemoryRunner,
  maybeSetOtelProviders,
  getGcpExporters,
  getGcpResource,
  OTelHooks
} from '@google/adk';

// Configure telemetry
const gcpExporters = await getGcpExporters({
  enableTracing: true,
  enableMetrics: true
});

const resource = getGcpResource();
maybeSetOtelProviders([gcpExporters], resource);

// Create and run agent
const agent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful support agent.'
});

const runner = new InMemoryRunner({agent});

// All invocations are automatically traced
for await (const event of runner.runAsync({
  userId: 'user_123',
  sessionId: 'session_abc',
  newMessage: {role: 'user', parts: [{text: 'Hello'}]}
})) {
  console.log(event);
}

// Traces are exported to Cloud Trace
```

## Best Practices

1. **Set up telemetry early** - Configure OpenTelemetry providers before creating agents
2. **Use GCP exporters in production** - For deployed applications on Google Cloud
3. **Consider privacy** - Set `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` if handling sensitive data
4. **Resource attributes** - Use `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` to identify your service
5. **Sampling** - For high-volume applications, configure sampling at the provider level
6. **Multiple backends** - You can combine multiple `OTelHooks` to export to multiple backends

## Related Documentation

- [Architecture](./architecture.md) - System design and patterns
- [Runner](./runner.md) - Execution orchestration
- [CLI](./cli.md) - Development server commands
- [API Reference](./api-reference.md) - REST API debug endpoints
