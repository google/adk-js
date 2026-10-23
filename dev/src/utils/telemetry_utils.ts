/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGcpExporters,
  getGcpProjectId,
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
      const attributes = span.attributes;
      const sessionId = (attributes['gcp.vertex.agent.session_id'] ??
        attributes['gen_ai.conversation.id']) as string | undefined;
      if (sessionId) {
        if (!this.traceDict[sessionId]) {
          this.traceDict[sessionId] = [traceId];
        } else {
          this.traceDict[sessionId].push(traceId);
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

/**
 * Sets up the OTel providers for the dev server.
 *
 * `internalProcessors` are the server's own processors, which see every span
 * and log record whatever else is configured. A plain array is taken as span
 * processors.
 *
 * @param otelToCloud Export traces, metrics and logs to Google Cloud.
 * @param internalProcessors The server's own span and log record processors.
 */
export async function setupTelemetry(
  otelToCloud: boolean = false,
  internalProcessors: SpanProcessor[] | OTelHooks = [],
): Promise<void> {
  const internalHooks: OTelHooks = Array.isArray(internalProcessors)
    ? {spanProcessors: internalProcessors}
    : internalProcessors;
  if (otelToCloud) {
    await setupGcpTelemetryExperimental(internalHooks);
  } else if (otelEnvVarsEnabled()) {
    await setupTelemetryFromEnvExperimental(internalHooks);
  } else {
    maybeSetOtelProviders([internalHooks]);
  }
}

async function setupGcpTelemetryExperimental(
  internalHooks: OTelHooks,
): Promise<void> {
  const projectId = await getGcpProjectId();
  const gcpExporters = await getGcpExporters({
    enableTracing: true,
    enableLogging: true,
    enableMetrics: true,
    projectId,
  });
  const otelResource = getGcpResource(projectId);

  maybeSetOtelProviders([internalHooks, gcpExporters], otelResource);
}

async function setupTelemetryFromEnvExperimental(
  internalHooks: OTelHooks,
): Promise<void> {
  maybeSetOtelProviders([internalHooks]);
}
