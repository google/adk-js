/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as adk from '@google/adk';
import type {Resource} from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  ApiServerSpanExporter,
  setupTelemetry,
} from '../../src/utils/telemetry_utils.js';

async function exportSpan(
  name: string,
  eventId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const traceDict: Record<string, Record<string, unknown>> = {};
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor(new ApiServerSpanExporter(traceDict)),
    ],
  });
  try {
    const span = provider
      .getTracer('test')
      .startSpan(name, {attributes: {'gcp.vertex.agent.event_id': eventId}});
    span.end();
    return traceDict;
  } finally {
    await provider.shutdown();
  }
}

describe('ApiServerSpanExporter', () => {
  it('maps the event of a generate_content span to its attributes', async () => {
    const traceDict = await exportSpan(
      'generate_content gemini-flash-latest',
      'event-1',
    );

    expect(traceDict['event-1']).toMatchObject({
      'gcp.vertex.agent.event_id': 'event-1',
    });
    expect(typeof traceDict['event-1']?.['trace_id']).toBe('string');
    expect(typeof traceDict['event-1']?.['span_id']).toBe('string');
  });

  it('ignores spans that do not stand for one event', async () => {
    const traceDict = await exportSpan('invoke_agent root', 'event-1');

    expect(traceDict).toEqual({});
  });
});

describe('setupTelemetry with otelToCloud', () => {
  it('enables logging and resolves project ID once for exporters and resource', async () => {
    const mockHooks = {
      spanProcessors: [],
      metricReaders: [],
      logRecordProcessors: [],
    };
    const mockResource = {
      attributes: {'gcp.project_id': 'resolved-project'},
    } as unknown as Resource;

    const getGcpProjectIdSpy = vi
      .spyOn(adk, 'getGcpProjectId')
      .mockResolvedValue('resolved-project');
    const getGcpExportersSpy = vi
      .spyOn(adk, 'getGcpExporters')
      .mockResolvedValue(mockHooks);
    const getGcpResourceSpy = vi
      .spyOn(adk, 'getGcpResource')
      .mockResolvedValue(mockResource);
    const maybeSetOtelProvidersSpy = vi
      .spyOn(adk, 'maybeSetOtelProviders')
      .mockReturnValue(undefined);

    const internalProcessor = {} as SpanProcessor;

    await setupTelemetry(true, [internalProcessor]);

    expect(getGcpProjectIdSpy).toHaveBeenCalledTimes(1);
    expect(getGcpExportersSpy).toHaveBeenCalledWith({
      enableTracing: true,
      enableLogging: true,
      enableMetrics: true,
      projectId: 'resolved-project',
    });
    expect(getGcpResourceSpy).toHaveBeenCalledWith('resolved-project');
    expect(maybeSetOtelProvidersSpy).toHaveBeenCalledWith(
      [
        {
          spanProcessors: [internalProcessor],
        },
        mockHooks,
      ],
      mockResource,
    );
  });
});

describe('setupTelemetry request hooks', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stubGcpSetup(spanProcessor: SpanProcessor) {
    vi.spyOn(adk, 'getGcpProjectId').mockResolvedValue('resolved-project');
    vi.spyOn(adk, 'getGcpExporters').mockResolvedValue({
      spanProcessors: [spanProcessor],
      metricReaders: [],
      logRecordProcessors: [],
    });
    vi.spyOn(adk, 'getGcpResource').mockResolvedValue({
      attributes: {},
    } as unknown as Resource);
    vi.spyOn(adk, 'maybeSetOtelProviders').mockReturnValue(undefined);
  }

  it('returns hooks that flush the cloud exporters on Agent Runtime', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'agent-123');
    const forceFlush = vi.fn().mockResolvedValue(undefined);
    stubGcpSetup({forceFlush} as unknown as SpanProcessor);

    const hooks = await setupTelemetry(true);
    await hooks?.onRequestEnd();

    expect(hooks).toBeDefined();
    expect(forceFlush).toHaveBeenCalledTimes(1);
  });

  it('returns no hooks off Agent Runtime', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', undefined);
    stubGcpSetup({} as SpanProcessor);

    await expect(setupTelemetry(true)).resolves.toBeUndefined();
  });

  it('returns no hooks without cloud export', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'agent-123');
    vi.spyOn(adk, 'maybeSetOtelProviders').mockReturnValue(undefined);

    await expect(setupTelemetry(false)).resolves.toBeUndefined();
  });
});
