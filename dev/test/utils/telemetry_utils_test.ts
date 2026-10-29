/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import {describe, expect, it} from 'vitest';

import {ApiServerSpanExporter} from '../../src/utils/telemetry_utils.js';

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
