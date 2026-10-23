/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, SpanStatusCode, trace} from '@opentelemetry/api';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {beforeEach, describe, expect, it} from 'vitest';

import {
  buildSpanDigest,
  normalizeValue,
  PRESENT,
  StartOrderSpanProcessor,
} from './functional_digest.js';

const spanExporter = new InMemorySpanExporter();
const startOrder = new StartOrderSpanProcessor();
const tracer = new BasicTracerProvider({
  spanProcessors: [startOrder, new SimpleSpanProcessor(spanExporter)],
}).getTracer('test');
const logExporter = new InMemoryLogRecordExporter();
const otelLogger = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({exporter: logExporter})],
}).getLogger('test');

/** A fixed start time, so ordering can only come from the start order. */
const START_TIME = 1_700_000_000_000;

function digest() {
  return buildSpanDigest({
    spans: spanExporter.getFinishedSpans(),
    logs: logExporter.getFinishedLogRecords(),
    startOrder,
  });
}

beforeEach(() => {
  spanExporter.reset();
  logExporter.reset();
  startOrder.reset();
});

describe('buildSpanDigest', () => {
  it('collapses generated ids on spans and logs to PRESENT', () => {
    const root = tracer.startSpan('root', {
      attributes: {
        'gcp.vertex.agent.event_id': 'event-1',
        'gen_ai.conversation.id': 'session-1',
        'gen_ai.agent.name': 'agent-1',
      },
    });
    otelLogger.emit({
      eventName: 'record',
      attributes: {'gcp.vertex.agent.invocation_id': 'inv-1', kept: 'value'},
      context: trace.setSpan(context.active(), root),
    });
    root.end();

    expect(digest()).toEqual({
      name: 'root',
      attributes: {
        'gcp.vertex.agent.event_id': PRESENT,
        'gen_ai.conversation.id': PRESENT,
        'gen_ai.agent.name': 'agent-1',
      },
      status: 'UNSET',
      children: [],
      logs: [
        {
          event_name: 'record',
          body: null,
          attributes: {
            'gcp.vertex.agent.invocation_id': PRESENT,
            kept: 'value',
          },
        },
      ],
    });
  });

  it('parses the JSON-encoded GenAI attributes and collapses nested ids', () => {
    tracer
      .startSpan('root', {
        attributes: {
          'gen_ai.output.messages': JSON.stringify([
            {parts: [{id: 'call-1', name: 'tool', type: 'tool_call'}]},
          ]),
          'gen_ai.tool.call.arguments': '{"arg1":"val1"}',
          other: '{"not":"parsed"}',
        },
      })
      .end();

    expect(digest().attributes).toEqual({
      'gen_ai.output.messages': [
        {parts: [{id: PRESENT, name: 'tool', type: 'tool_call'}]},
      ],
      'gen_ai.tool.call.arguments': {arg1: 'val1'},
      other: '{"not":"parsed"}',
    });
  });

  it('attaches each log to its span in emission order', () => {
    const root = tracer.startSpan('root');
    const rootContext = trace.setSpan(context.active(), root);
    const child = tracer.startSpan('child', {}, rootContext);
    const childContext = trace.setSpan(context.active(), child);
    otelLogger.emit({eventName: 'first', body: {a: 1}, context: childContext});
    otelLogger.emit({eventName: 'on-root', context: rootContext});
    otelLogger.emit({eventName: 'second', context: childContext});
    child.end();
    root.end();

    const result = digest();
    expect(result.logs.map((log) => log.event_name)).toEqual(['on-root']);
    expect(result.children[0].logs).toEqual([
      {event_name: 'first', body: {a: 1}, attributes: {}},
      {event_name: 'second', body: null, attributes: {}},
    ]);
  });

  it('orders children by start even when their start times are equal', () => {
    const root = tracer.startSpan('root', {startTime: START_TIME});
    const rootContext = trace.setSpan(context.active(), root);
    const first = tracer.startSpan(
      'first',
      {startTime: START_TIME},
      rootContext,
    );
    const second = tracer.startSpan(
      'second',
      {startTime: START_TIME},
      rootContext,
    );
    second.end();
    first.end();
    root.end();

    expect(digest().children.map((child) => child.name)).toEqual([
      'first',
      'second',
    ]);
  });

  it('reports the status name', () => {
    const root = tracer.startSpan('root');
    root.setStatus({code: SpanStatusCode.ERROR, message: 'Boom'});
    root.end();

    expect(digest().status).toBe('ERROR');
  });

  it('throws when there are two roots', () => {
    tracer.startSpan('root-1').end();
    tracer.startSpan('root-2').end();

    expect(() => digest()).toThrow('Multiple root spans found.');
  });

  it('throws when there is no root', () => {
    expect(() => digest()).toThrow('No root span found in the provided spans.');
  });
});

describe('normalizeValue', () => {
  it('drops null and undefined object entries but keeps array elements', () => {
    expect(
      normalizeValue({a: null, b: undefined, c: [null, 1], d: {e: null}}),
    ).toEqual({c: [null, 1], d: {}});
  });

  it('collapses every object key named id', () => {
    expect(normalizeValue([{id: 'x', nested: {id: 'y', value: 1}}])).toEqual([
      {id: PRESENT, nested: {id: PRESENT, value: 1}},
    ]);
  });
});
