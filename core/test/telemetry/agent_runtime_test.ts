/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  InvocationContext,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  PluginManager,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {recordInference} from '../../src/telemetry/api/instrumentation.js';
import {agentRuntimeRequestHooks} from '../../src/telemetry/export/agent_runtime.js';
import {RequestDrivenMetricReader} from '../../src/telemetry/export/request_driven_metric_reader.js';
import {logger} from '../../src/utils/logger.js';

const PERIOD = 60000;
const FLOOR = 5000;

type ExportCallback = Parameters<PushMetricExporter['export']>[1];

/** Records the clock time of every export, or throws when told to. */
class RecordingExporter implements PushMetricExporter {
  readonly exportTimes: number[] = [];
  throwOnExport = false;

  constructor(private readonly now: () => number) {}

  export(_metrics: ResourceMetrics, resultCallback: ExportCallback): void {
    this.exportTimes.push(this.now());
    if (this.throwOnExport) {
      throw new Error('exporter crashed');
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

/** A reader that counts how often it is flushed. */
class CountingMetricReader extends MetricReader {
  forceFlushCalls = 0;

  protected override async onForceFlush(): Promise<void> {
    this.forceFlushCalls += 1;
  }

  protected override async onShutdown(): Promise<void> {}
}

/** A span processor whose flush fails, synchronously or not. */
function failingSpanProcessor(how: 'reject' | 'throw'): SpanProcessor {
  return {
    onStart: () => {},
    onEnd: () => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => {
      if (how === 'throw') {
        throw new Error('flush crashed');
      }
      return Promise.reject(new Error('flush rejected'));
    },
  };
}

describe('agentRuntimeRequestHooks', () => {
  let time = 0;
  const now = () => time;
  const shutdowns: Array<() => Promise<void>> = [];

  function createReader() {
    const exporter = new RecordingExporter(now);
    const reader = new RequestDrivenMetricReader({
      exporter,
      now,
      exportIntervalMillis: PERIOD,
      floorMillis: FLOOR,
    });
    const provider = new MeterProvider({readers: [reader]});
    provider.getMeter('test').createCounter('requests').add(1);
    shutdowns.push(() => provider.shutdown());
    return {reader, exporter};
  }

  beforeEach(() => {
    time = 0;
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.allSettled(shutdowns.splice(0).map((shutdown) => shutdown()));
    vi.restoreAllMocks();
  });

  it('drains the reader and flushes span and log processors on request end', async () => {
    const {reader, exporter} = createReader();
    const spanExporter = new InMemorySpanExporter();
    const spanProcessor = new BatchSpanProcessor(spanExporter);
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [spanProcessor],
    });
    const logExporter = new InMemoryLogRecordExporter();
    const logProcessor = new BatchLogRecordProcessor({exporter: logExporter});
    const loggerProvider = new LoggerProvider({processors: [logProcessor]});
    shutdowns.push(
      () => tracerProvider.shutdown(),
      () => loggerProvider.shutdown(),
    );
    const hooks = agentRuntimeRequestHooks({
      spanProcessors: [spanProcessor],
      metricReaders: [reader],
      logRecordProcessors: [logProcessor],
    });

    hooks.onRequestStart();
    tracerProvider.getTracer('test').startSpan('handle request').end();
    loggerProvider.getLogger('test').emit({body: 'handled'});
    expect(spanExporter.getFinishedSpans()).toHaveLength(0);
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    time = 10000;
    await hooks.onRequestEnd();

    expect(exporter.exportTimes).toEqual([10000]);
    expect(spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(logExporter.getFinishedLogRecords()).toHaveLength(1);
  });

  it('leaves other metric readers alone', async () => {
    const counting = new CountingMetricReader();
    const provider = new MeterProvider({readers: [counting]});
    shutdowns.push(() => provider.shutdown());
    const hooks = agentRuntimeRequestHooks({metricReaders: [counting]});

    hooks.onRequestStart();
    await hooks.onRequestEnd();

    expect(counting.forceFlushCalls).toBe(0);
  });

  it.each(['reject', 'throw'] as const)(
    'resolves when a processor flush fails with %s',
    async (how) => {
      const {reader, exporter} = createReader();
      const hooks = agentRuntimeRequestHooks({
        spanProcessors: [failingSpanProcessor(how)],
        metricReaders: [reader],
      });

      hooks.onRequestStart();
      time = 10000;
      await expect(hooks.onRequestEnd()).resolves.toBeUndefined();

      expect(exporter.exportTimes).toEqual([10000]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Telemetry flush on request end failed'),
      );
    },
  );

  it('resolves when the metric exporter throws', async () => {
    const {reader, exporter} = createReader();
    exporter.throwOnExport = true;
    const hooks = agentRuntimeRequestHooks({metricReaders: [reader]});

    expect(() => hooks.onRequestStart()).not.toThrow();
    time = 10000;

    await expect(hooks.onRequestEnd()).resolves.toBeUndefined();
  });

  it('works with no request-driven reader', async () => {
    const spanExporter = new InMemorySpanExporter();
    const spanProcessor = new BatchSpanProcessor(spanExporter);
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [spanProcessor],
    });
    shutdowns.push(() => tracerProvider.shutdown());
    const hooks = agentRuntimeRequestHooks({spanProcessors: [spanProcessor]});

    hooks.onRequestStart();
    tracerProvider.getTracer('test').startSpan('handle request').end();
    await hooks.onRequestEnd();

    expect(spanExporter.getFinishedSpans()).toHaveLength(1);
  });

  it('collects when a model call starts 1.5 periods into a long request', async () => {
    const {reader, exporter} = createReader();
    const hooks = agentRuntimeRequestHooks({metricReaders: [reader]});
    const llmRequest: LlmRequest = {
      model: 'gemini-flash-latest',
      contents: [{role: 'user', parts: [{text: 'hello'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };
    const response: LlmResponse = {
      content: {role: 'model', parts: [{text: 'done'}]},
      finishReason: FinishReason.STOP,
    };
    const invocationContext = new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: 'test_agent', description: 'A test agent'}),
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'user-1',
      }),
      pluginManager: new PluginManager([]),
    });

    hooks.onRequestStart();
    time = 1.5 * PERIOD;
    for await (const _ of recordInference(
      {
        invocationContext,
        llmRequest,
        modelResponseEvent: createEvent({id: 'event-1', author: 'test_agent'}),
      },
      async function* () {
        yield response;
      },
    )) {
      // Drains the stream.
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(exporter.exportTimes).toEqual([1.5 * PERIOD]);
  });
});
