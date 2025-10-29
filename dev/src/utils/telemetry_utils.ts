import {
  getGcpExporters,
  getGcpResource,
  maybeSetOtelProviders,
  OTelHooks,
} from '@google/adk';
import {HrTime} from '@opentelemetry/api';
import {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/**
 * Converts HrTime to nanoseconds timestamp
 *
 * @param hrTime The HrTime array [seconds, nanoseconds]
 * @returns Time in nanoseconds as a number
 */
export function hrTimeToNanoseconds(hrTime: HrTime): number {
  if (!hrTime || !Array.isArray(hrTime) || hrTime.length !== 2) {
    return 0;
  }

  const [seconds, nanoseconds] = hrTime;

  return seconds * 1e9 + nanoseconds;
}

export class ApiServerSpanExporter implements SpanExporter {
  private traceDict: Record<string, Record<string, unknown>>;

  constructor(traceDict: Record<string, Record<string, unknown>>) {
    this.traceDict = traceDict;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: {code: number}) => void,
  ): void {
    for (const span of spans) {
      if (
        span.name === 'call_llm' ||
        span.name === 'send_data' ||
        span.name.startsWith('execute_tool')
      ) {
        const attributes = {...span.attributes};
        attributes['trace_id'] = span.spanContext().traceId;
        attributes['span_id'] = span.spanContext().spanId;

        const eventId = attributes['gcp.vertex.agent.event_id'];
        if (eventId) {
          this.traceDict[eventId as string] = attributes;
        }
      }
    }
    resultCallback({code: 0});
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export class InMemoryExporter implements SpanExporter {
  private spans: ReadableSpan[] = [];
  private traceDict: Record<string, string[]>;

  constructor(traceDict: Record<string, string[]>) {
    this.traceDict = traceDict;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: {code: number}) => void,
  ): void {
    for (const span of spans) {
      const traceId = span.spanContext().traceId;
      if (span.name === 'call_llm') {
        const attributes = {...span.attributes};
        const sessionId = attributes['gcp.vertex.agent.session_id'] as string;
        if (sessionId) {
          if (!this.traceDict[sessionId]) {
            this.traceDict[sessionId] = [traceId];
          } else {
            this.traceDict[sessionId].push(traceId);
          }
        }
      }
    }
    this.spans.push(...spans);
    resultCallback({code: 0});
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  getFinishedSpans(sessionId: string): ReadableSpan[] {
    const traceIds = this.traceDict[sessionId];
    if (!traceIds || traceIds.length === 0) {
      return [];
    }
    return this.spans.filter((span) =>
      traceIds.includes(span.spanContext().traceId),
    );
  }

  clear(): void {
    this.spans = [];
  }
}

function otelEnvVarsEnabled(): boolean {
  const endpointVars = [
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  ];

  return endpointVars.some((varName) => process.env[varName]);
}

export async function setupTelemetry(
  otelToCloud: boolean = false,
  internalExporters: SpanProcessor[] = [],
): Promise<void> {
  if (otelToCloud) {
    await setupGcpTelemetryExperimental(internalExporters);
  } else if (otelEnvVarsEnabled()) {
    await setupTelemetryFromEnvExperimental(internalExporters);
  } else {
    const otelHooks: OTelHooks = {
      spanProcessors: internalExporters,
    };
    maybeSetOtelProviders([otelHooks]);
  }
}

async function setupGcpTelemetryExperimental(
  internalExporters: SpanProcessor[] = [],
): Promise<void> {
  const otelHooksToAdd: OTelHooks[] = [];

  if (internalExporters.length > 0) {
    otelHooksToAdd.push({
      spanProcessors: internalExporters,
    });
  }

  const gcpExporters = await getGcpExporters({
    enableTracing: true,
    enableLogging: false,
    enableMetrics: true,
  });
  otelHooksToAdd.push(gcpExporters);

  const otelResource = getGcpResource();

  maybeSetOtelProviders(otelHooksToAdd, otelResource);
}

async function setupTelemetryFromEnvExperimental(
  internalExporters: SpanProcessor[] = [],
): Promise<void> {
  const otelHooksToAdd: OTelHooks[] = [];

  if (internalExporters.length > 0) {
    otelHooksToAdd.push({
      spanProcessors: internalExporters,
    });
  }

  maybeSetOtelProviders(otelHooksToAdd);
}
