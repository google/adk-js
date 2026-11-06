/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {describe, expect, it} from 'vitest';

import {ApiServerSpanExporter} from '../../src/utils/telemetry_utils.js';

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
