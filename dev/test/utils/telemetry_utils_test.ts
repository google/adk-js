/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as adk from '@google/adk';
import type {Resource} from '@opentelemetry/resources';
import {ReadableSpan, SpanProcessor} from '@opentelemetry/sdk-trace-base';
import {describe, expect, it, vi} from 'vitest';

import {
  ApiServerSpanExporter,
  setupTelemetry,
} from '../../src/utils/telemetry_utils.js';

function makeSpan(name: string, eventId: string): ReadableSpan {
  return {
    name,
    spanContext: () => ({traceId: 'trace-1', spanId: 'span-1'}),
    attributes: {'gcp.vertex.agent.event_id': eventId},
  } as unknown as ReadableSpan;
}

describe('ApiServerSpanExporter', () => {
  it('maps the event of a generate_content span to its attributes', () => {
    const traceDict: Record<string, Record<string, unknown>> = {};
    const exporter = new ApiServerSpanExporter(traceDict);

    exporter.export(
      [makeSpan('generate_content gemini-flash-latest', 'event-1')],
      () => {},
    );

    expect(traceDict['event-1']).toEqual({
      'gcp.vertex.agent.event_id': 'event-1',
      'trace_id': 'trace-1',
      'span_id': 'span-1',
    });
  });

  it('ignores spans that do not stand for one event', () => {
    const traceDict: Record<string, Record<string, unknown>> = {};
    const exporter = new ApiServerSpanExporter(traceDict);

    exporter.export([makeSpan('invoke_agent root', 'event-1')], () => {});

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
