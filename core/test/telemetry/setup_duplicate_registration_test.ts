/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {maybeSetOtelProviders} from '@google/adk';
import {
  DiagLogLevel,
  context,
  diag,
  metrics,
  propagation,
  trace,
} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

describe('maybeSetOtelProviders OpenTelemetry registration', () => {
  const readersToCleanup: PeriodicExportingMetricReader[] = [];
  const providersToCleanup: Array<{shutdown?: () => Promise<void>}> = [];

  function cleanupGlobals() {
    trace.disable();
    context.disable();
    propagation.disable();
    metrics.disable();
    logs.disable();
    diag.disable();
  }

  beforeEach(() => {
    cleanupGlobals();
  });

  afterEach(async () => {
    for (const reader of readersToCleanup) {
      await reader.shutdown();
    }
    readersToCleanup.length = 0;
    for (const provider of providersToCleanup) {
      await provider.shutdown?.();
    }
    providersToCleanup.length = 0;
    cleanupGlobals();
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

  it('does not re-register providers or log diagnostic errors when called twice', async () => {
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

    const spanExporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60000,
    });
    readersToCleanup.push(metricReader);
    const logExporter = new InMemoryLogRecordExporter();
    const logProcessor = new SimpleLogRecordProcessor({exporter: logExporter});

    maybeSetOtelProviders([
      {
        spanProcessors: [new SimpleSpanProcessor(spanExporter)],
        metricReaders: [metricReader],
        logRecordProcessors: [logProcessor],
      },
    ]);

    const secondMetricReader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60000,
    });
    readersToCleanup.push(secondMetricReader);

    maybeSetOtelProviders([
      {
        spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
        metricReaders: [secondMetricReader],
        logRecordProcessors: [
          new SimpleLogRecordProcessor({
            exporter: new InMemoryLogRecordExporter(),
          }),
        ],
      },
    ]);

    expect(errors).toEqual([]);

    const span = trace.getTracer('adk-test').startSpan('duplicate-test-span');
    span.end();
    expect(spanExporter.getFinishedSpans()).toHaveLength(1);

    const meter = metrics.getMeter('adk-test');
    const counter = meter.createCounter('duplicate-test-counter');
    counter.add(1);
    await metricReader.forceFlush();
    expect(metricExporter.getMetrics()).toHaveLength(1);

    const logger = logs.getLogger('adk-test');
    logger.emit({body: 'duplicate-test-log'});
    await logProcessor.forceFlush();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(1);
  });

  it('does not re-register pre-registered TracerProvider while registering MeterProvider and LoggerProvider', async () => {
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

    const preRegisteredSpanExporter = new InMemorySpanExporter();
    const preRegisteredTracerProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(preRegisteredSpanExporter)],
    });
    preRegisteredTracerProvider.register();
    providersToCleanup.push(preRegisteredTracerProvider);

    const callSpanExporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60000,
    });
    readersToCleanup.push(metricReader);
    const logExporter = new InMemoryLogRecordExporter();
    const logProcessor = new SimpleLogRecordProcessor({exporter: logExporter});

    maybeSetOtelProviders([
      {
        spanProcessors: [new SimpleSpanProcessor(callSpanExporter)],
        metricReaders: [metricReader],
        logRecordProcessors: [logProcessor],
      },
    ]);

    expect(errors).toEqual([]);

    const span = trace.getTracer('adk-test').startSpan('pre-registered-span');
    span.end();
    expect(preRegisteredSpanExporter.getFinishedSpans()).toHaveLength(1);
    expect(callSpanExporter.getFinishedSpans()).toHaveLength(0);

    const meter = metrics.getMeter('adk-test');
    const counter = meter.createCounter('pre-registered-test-counter');
    counter.add(1);
    await metricReader.forceFlush();
    expect(metricExporter.getMetrics()).toHaveLength(1);

    const logger = logs.getLogger('adk-test');
    logger.emit({body: 'pre-registered-test-log'});
    await logProcessor.forceFlush();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(1);
  });
});
