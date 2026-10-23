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
import {context, trace} from '@opentelemetry/api';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  ApiServerSpanExporter,
  InMemoryExporter,
  setupTelemetry,
} from '../../src/utils/telemetry_utils.js';

vi.mock('@google/adk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@google/adk')>();
  return {
    ...original,
    getGcpExporters: vi.fn(),
    getGcpProjectId: vi.fn(),
    getGcpResource: vi.fn(),
    maybeSetOtelProviders: vi.fn(),
  };
});

describe('setupTelemetry', () => {
  const spanProcessor = new SimpleSpanProcessor(new InMemorySpanExporter());
  const logRecordProcessor = new SimpleLogRecordProcessor({
    exporter: new InMemoryLogRecordExporter(),
  });
  const internalHooks: OTelHooks = {
    spanProcessors: [spanProcessor],
    logRecordProcessors: [logRecordProcessor],
  };

  beforeEach(() => {
    for (const name of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('enables Cloud Logging and names the project in the resource with otelToCloud', async () => {
    const gcpHooks: OTelHooks = {logRecordProcessors: []};
    const resource = resourceFromAttributes({'gcp.project_id': 'my-project'});
    vi.mocked(getGcpExporters).mockResolvedValue(gcpHooks);
    vi.mocked(getGcpProjectId).mockResolvedValue('my-project');
    vi.mocked(getGcpResource).mockReturnValue(resource);

    await setupTelemetry(true, internalHooks);

    expect(getGcpExporters).toHaveBeenCalledWith({
      enableTracing: true,
      enableLogging: true,
      enableMetrics: true,
      projectId: 'my-project',
    });
    expect(getGcpResource).toHaveBeenCalledWith('my-project');
    expect(maybeSetOtelProviders).toHaveBeenCalledWith(
      [internalHooks, gcpHooks],
      resource,
    );
  });

  it('forwards the internal log processors on the OTLP environment path', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');

    await setupTelemetry(false, internalHooks);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([internalHooks]);
    expect(getGcpExporters).not.toHaveBeenCalled();
  });

  it('forwards the internal log processors on the default path', async () => {
    await setupTelemetry(false, internalHooks);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([internalHooks]);
  });

  it('still takes a plain array as span processors', async () => {
    await setupTelemetry(false, [spanProcessor]);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([
      {spanProcessors: [spanProcessor]},
    ]);
  });
});

/** Returns a tracer whose spans go to `exporter` as they end. */
function tracerFor(exporter: SpanExporter) {
  return new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  }).getTracer('test');
}

describe('ApiServerSpanExporter', () => {
  it('keys a generate_content span by its event id', () => {
    const traceDict: Record<string, Record<string, unknown>> = {};
    const tracer = tracerFor(new ApiServerSpanExporter(traceDict));

    tracer
      .startSpan('generate_content gemini-flash-latest', {
        attributes: {
          'gcp.vertex.agent.event_id': 'event-1',
          'gen_ai.operation.name': 'generate_content',
        },
      })
      .end();

    expect(traceDict['event-1']).toMatchObject({
      'gen_ai.operation.name': 'generate_content',
      trace_id: expect.any(String),
      span_id: expect.any(String),
    });
  });

  it('lets call_llm, which ends later, replace the generate_content entry', () => {
    const traceDict: Record<string, Record<string, unknown>> = {};
    const tracer = tracerFor(new ApiServerSpanExporter(traceDict));
    const callLlm = tracer.startSpan('call_llm', {
      attributes: {
        'gcp.vertex.agent.event_id': 'event-1',
        'gen_ai.system': 'gcp.vertex.agent',
      },
    });

    tracer
      .startSpan('generate_content gemini-flash-latest', {
        attributes: {'gcp.vertex.agent.event_id': 'event-1'},
      })
      .end();
    callLlm.end();

    expect(traceDict['event-1']).toMatchObject({
      'gen_ai.system': 'gcp.vertex.agent',
    });
  });

  it('ignores spans of other steps', () => {
    const traceDict: Record<string, Record<string, unknown>> = {};
    const tracer = tracerFor(new ApiServerSpanExporter(traceDict));

    tracer
      .startSpan('invoke_agent root', {
        attributes: {'gcp.vertex.agent.event_id': 'event-1'},
      })
      .end();

    expect(traceDict).toEqual({});
  });
});

describe('InMemoryExporter', () => {
  it('records a trace id once per session and returns every span of the trace', () => {
    const traceDict: Record<string, string[]> = {};
    const exporter = new InMemoryExporter(traceDict);
    const tracer = tracerFor(exporter);

    const root = tracer.startSpan('invocation');
    const rootContext = trace.setSpan(context.active(), root);
    for (const name of [
      'invoke_agent root',
      'generate_content gemini-flash-latest',
    ]) {
      tracer
        .startSpan(
          name,
          {attributes: {'gen_ai.conversation.id': 'session-1'}},
          rootContext,
        )
        .end();
    }
    root.end();

    expect(traceDict['session-1']).toHaveLength(1);
    expect(
      exporter
        .getFinishedSpans('session-1')
        .map((span) => span.name)
        .sort(),
    ).toEqual([
      'generate_content gemini-flash-latest',
      'invocation',
      'invoke_agent root',
    ]);
  });
});
