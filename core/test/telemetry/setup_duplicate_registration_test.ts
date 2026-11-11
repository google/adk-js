/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {maybeSetOtelProviders} from '@google/adk';
import {DiagLogLevel, diag, trace} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, describe, expect, it} from 'vitest';

describe('maybeSetOtelProviders OpenTelemetry registration', () => {
  afterEach(() => {
    trace.disable();
    diag.disable();
  });

  it('registers the tracer provider once without a diagnostic error', () => {
    const errors: string[] = [];
    diag.setLogger(
      {
        verbose() {},
        debug() {},
        info() {},
        warn() {},
        error(...args) {
          errors.push(args.map(String).join(' '));
        },
      },
      DiagLogLevel.ALL,
    );

    const exporter = new InMemorySpanExporter();
    maybeSetOtelProviders([
      {spanProcessors: [new SimpleSpanProcessor(exporter)]},
    ]);

    const span = trace.getTracer('adk-test').startSpan('registration');
    span.end();

    expect(errors).toEqual([]);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});
