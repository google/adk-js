/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SpanKind, SpanStatusCode, TraceFlags} from '@opentelemetry/api';
import {InstrumentationScope} from '@opentelemetry/core';
import {defaultResource} from '@opentelemetry/resources';
import {ReadableLogRecord} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  DataPointType,
  InstrumentType,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import {describe, expect, it} from 'vitest';

import {buildTelemetryDigest, PRESENT} from './digests.js';

const TEST_SCOPE: InstrumentationScope = {
  name: 'test-scope',
  version: '1.0.0',
};

function makeFakeSpan(options: {
  name: string;
  spanId: string;
  parentSpanId?: string;
  startTime?: [number, number];
  status?: SpanStatusCode;
  attributes?: Record<string, unknown>;
}): ReadableSpan {
  const {
    name,
    spanId,
    parentSpanId,
    startTime = [1, 0],
    status = SpanStatusCode.UNSET,
    attributes = {},
  } = options;
  return {
    name,
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: '00000000000000000000000000000001',
      spanId,
      traceFlags: TraceFlags.SAMPLED,
    }),
    parentSpanContext: parentSpanId
      ? {
          traceId: '00000000000000000000000000000001',
          spanId: parentSpanId,
          traceFlags: TraceFlags.SAMPLED,
        }
      : undefined,
    startTime,
    endTime: [startTime[0] + 1, 0],
    status: {code: status},
    attributes: attributes as ReadableSpan['attributes'],
    links: [],
    events: [],
    duration: [1, 0],
    ended: true,
    resource: defaultResource(),
    instrumentationScope: TEST_SCOPE,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function makeFakeLog(options: {
  eventName: string;
  spanId?: string;
  observedTime?: [number, number];
  body?: unknown;
  attributes?: Record<string, unknown>;
}): ReadableLogRecord {
  const {
    eventName,
    spanId,
    observedTime = [1, 0],
    body = null,
    attributes = {},
  } = options;
  return {
    hrTime: observedTime,
    hrTimeObserved: observedTime,
    spanContext: spanId
      ? {
          traceId: '00000000000000000000000000000001',
          spanId,
          traceFlags: TraceFlags.SAMPLED,
        }
      : undefined,
    eventName,
    body: body as ReadableLogRecord['body'],
    resource: defaultResource(),
    instrumentationScope: TEST_SCOPE,
    attributes: attributes as ReadableLogRecord['attributes'],
    droppedAttributesCount: 0,
  };
}

describe('buildTelemetryDigest', () => {
  it('normalizes non-deterministic attributes and parses JSON attributes', () => {
    const rootSpan = makeFakeSpan({
      name: 'invocation',
      spanId: 'span-root',
      startTime: [1, 0],
      attributes: {
        'gcp.vertex.agent.invocation_id': 'e-1234',
        'gcp.vertex.agent.session_id': 's-5678',
        'gen_ai.conversation.id': 'c-9999',
      },
    });
    const childSpan = makeFakeSpan({
      name: 'call_llm',
      spanId: 'span-child',
      parentSpanId: 'span-root',
      startTime: [2, 0],
      status: SpanStatusCode.OK,
      attributes: {
        'gcp.vertex.agent.event_id': 'evt-1',
        'gen_ai.tool.call.id': 'call-1',
        'gcp.vertex.agent.llm_request': JSON.stringify({
          model: 'gemini-2.5-flash',
          emptyField: null,
          contents: [
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'adk-random-uuid',
                    name: 'some_tool',
                    args: {arg1: 'val1'},
                  },
                },
              ],
            },
          ],
        }),
        'gcp.vertex.agent.tool_response': '<not specified>',
      },
    });
    const logRecord = makeFakeLog({
      eventName: 'gen_ai.client.inference.operation.details',
      spanId: 'span-child',
      observedTime: [2, 50],
      body: {id: 'generated-body-id', text: 'hello', ignored: null},
      attributes: {
        'gcp.vertex.agent.event_id': 'evt-1',
        'gen_ai.agent.name': 'some_root_agent',
      },
    });

    const digest = buildTelemetryDigest([childSpan, rootSpan], [logRecord]);

    expect(digest).toEqual({
      root_span: {
        name: 'invocation',
        attributes: {
          'gcp.vertex.agent.invocation_id': PRESENT,
          'gcp.vertex.agent.session_id': PRESENT,
          'gen_ai.conversation.id': PRESENT,
        },
        status: 'UNSET',
        children: [
          {
            name: 'call_llm',
            attributes: {
              'gcp.vertex.agent.event_id': PRESENT,
              'gcp.vertex.agent.llm_request': {
                contents: [
                  {
                    parts: [
                      {
                        functionCall: {
                          args: {arg1: 'val1'},
                          id: PRESENT,
                          name: 'some_tool',
                        },
                      },
                    ],
                    role: 'model',
                  },
                ],
                model: 'gemini-2.5-flash',
              },
              'gcp.vertex.agent.tool_response': '<not specified>',
              'gen_ai.tool.call.id': PRESENT,
            },
            status: 'OK',
            children: [],
            logs: [
              {
                event_name: 'gen_ai.client.inference.operation.details',
                body: {id: PRESENT, text: 'hello'},
                attributes: {
                  'gcp.vertex.agent.event_id': PRESENT,
                  'gen_ai.agent.name': 'some_root_agent',
                },
              },
            ],
          },
        ],
        logs: [],
      },
      metric_points: {},
    });
  });

  it('sorts metric points by metric name and attributes and collapses duration histograms', () => {
    const rootSpan = makeFakeSpan({name: 'root', spanId: 'span-1'});
    const resourceMetrics: ResourceMetrics = {
      resource: defaultResource(),
      scopeMetrics: [
        {
          scope: TEST_SCOPE,
          metrics: [
            {
              descriptor: {
                name: 'gen_ai.client.token.usage',
                description: '',
                unit: '{token}',
                valueType: 1,
                type: InstrumentType.HISTOGRAM,
              } as ResourceMetrics['scopeMetrics'][number]['metrics'][number]['descriptor'],
              aggregationTemporality: AggregationTemporality.CUMULATIVE,
              dataPointType: DataPointType.HISTOGRAM,
              dataPoints: [
                {
                  startTime: [1, 0],
                  endTime: [2, 0],
                  attributes: {'gen_ai.token.type': 'output'},
                  value: {
                    buckets: {boundaries: [], counts: [1]},
                    count: 1,
                    sum: 25,
                    min: 25,
                    max: 25,
                  },
                },
                {
                  startTime: [1, 0],
                  endTime: [2, 0],
                  attributes: {'gen_ai.token.type': 'input'},
                  value: {
                    buckets: {boundaries: [], counts: [1]},
                    count: 1,
                    sum: 100,
                    min: 100,
                    max: 100,
                  },
                },
              ],
            },
            {
              descriptor: {
                name: 'gen_ai.client.operation.duration',
                description: '',
                unit: 's',
                valueType: 1,
                type: InstrumentType.HISTOGRAM,
              } as ResourceMetrics['scopeMetrics'][number]['metrics'][number]['descriptor'],
              aggregationTemporality: AggregationTemporality.CUMULATIVE,
              dataPointType: DataPointType.HISTOGRAM,
              dataPoints: [
                {
                  startTime: [1, 0],
                  endTime: [2, 0],
                  attributes: {'gen_ai.operation.name': 'generate_content'},
                  value: {
                    buckets: {boundaries: [], counts: [1]},
                    count: 1,
                    sum: 0.42,
                    min: 0.42,
                    max: 0.42,
                  },
                },
              ],
            },
            {
              descriptor: {
                name: 'gen_ai.invoke_agent.tool_calls',
                description: '',
                unit: '{call}',
                valueType: 0,
                type: InstrumentType.COUNTER,
              } as ResourceMetrics['scopeMetrics'][number]['metrics'][number]['descriptor'],
              aggregationTemporality: AggregationTemporality.CUMULATIVE,
              dataPointType: DataPointType.SUM,
              isMonotonic: true,
              dataPoints: [
                {
                  startTime: [1, 0],
                  endTime: [2, 0],
                  attributes: {'gen_ai.agent.name': 'some_root_agent'},
                  value: 1,
                },
              ],
            },
          ],
        },
      ],
    };

    const digest = buildTelemetryDigest([rootSpan], [], [resourceMetrics]);

    expect(Object.keys(digest.metric_points)).toEqual([
      'gen_ai.client.operation.duration',
      'gen_ai.client.token.usage',
      'gen_ai.invoke_agent.tool_calls',
    ]);
    expect(digest.metric_points['gen_ai.client.operation.duration']).toEqual([
      {
        attributes: {'gen_ai.operation.name': 'generate_content'},
        value: PRESENT,
      },
    ]);
    expect(digest.metric_points['gen_ai.client.token.usage']).toEqual([
      {
        attributes: {'gen_ai.token.type': 'input'},
        value: 100,
      },
      {
        attributes: {'gen_ai.token.type': 'output'},
        value: 25,
      },
    ]);
    expect(digest.metric_points['gen_ai.invoke_agent.tool_calls']).toEqual([
      {
        attributes: {'gen_ai.agent.name': 'some_root_agent'},
        value: 1,
      },
    ]);
  });

  it('throws when a log record is emitted outside any collected span', () => {
    const rootSpan = makeFakeSpan({name: 'root', spanId: 'span-1'});
    const orphanLog = makeFakeLog({
      eventName: 'orphan.event',
      spanId: 'non-existent-span',
    });
    const unattachedLog = makeFakeLog({
      eventName: 'unattached.event',
    });

    expect(() => buildTelemetryDigest([rootSpan], [orphanLog])).toThrow(
      /outside any collected span/,
    );
    expect(() => buildTelemetryDigest([rootSpan], [unattachedLog])).toThrow(
      /outside any collected span/,
    );
  });

  it('throws when zero or multiple root spans are provided', () => {
    expect(() => buildTelemetryDigest([])).toThrow(/No root span found/);

    const root1 = makeFakeSpan({name: 'root1', spanId: 'span-1'});
    const root2 = makeFakeSpan({name: 'root2', spanId: 'span-2'});
    expect(() => buildTelemetryDigest([root1, root2])).toThrow(
      /Multiple root spans found/,
    );
  });
});
