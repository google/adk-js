/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {RequestDrivenMetricReader} from '../../src/telemetry/export/request_driven_metric_reader.js';
import {logger} from '../../src/utils/logger.js';

const PERIOD = 60000;
const FLOOR = 5000;
const INFERENCE_START_HOOK_KEY = Symbol.for(
  'google.adk.telemetry.inferenceStartHook',
);

type ExportCallback = Parameters<PushMetricExporter['export']>[1];
type ExportMode = 'succeed' | 'fail' | 'throw' | 'hang' | 'hold';

/** Records the clock time of every export; can fail in several ways. */
class RecordingExporter implements PushMetricExporter {
  readonly exportTimes: number[] = [];
  mode: ExportMode = 'succeed';
  heldCallback?: ExportCallback;
  forceFlushCalls = 0;
  shutdownCalls = 0;

  constructor(
    private readonly now: () => number,
    readonly temporality?: AggregationTemporality,
  ) {}

  export(_metrics: ResourceMetrics, resultCallback: ExportCallback): void {
    this.exportTimes.push(this.now());
    switch (this.mode) {
      case 'succeed':
        resultCallback({code: 0});
        return;
      case 'fail':
        resultCallback({code: 1, error: new Error('backend unavailable')});
        return;
      case 'throw':
        throw new Error('exporter crashed');
      case 'hang':
        return;
      case 'hold':
        this.heldCallback = resultCallback;
        return;
      default: {
        const exhaustive: never = this.mode;
        throw new Error(`Unknown mode: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  selectAggregationTemporality(): AggregationTemporality {
    return this.temporality ?? AggregationTemporality.CUMULATIVE;
  }

  forceFlush(): Promise<void> {
    this.forceFlushCalls += 1;
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    return Promise.resolve();
  }
}

interface HarnessOptions {
  readonly exportIntervalMillis?: number;
  readonly exportTimeoutMillis?: number;
  readonly floorMillis?: number;
  readonly temporality?: AggregationTemporality;
}

/** A reader on a real `MeterProvider`, driven by a clock the test sets. */
function createHarness(options: HarnessOptions = {}) {
  let time = 0;
  const now = () => time;
  const exporter = new RecordingExporter(now, options.temporality);
  const reader = new RequestDrivenMetricReader({
    exporter,
    now,
    exportIntervalMillis: options.exportIntervalMillis,
    exportTimeoutMillis: options.exportTimeoutMillis,
    floorMillis: options.floorMillis,
  });
  const provider = new MeterProvider({readers: [reader]});
  // A cumulative counter keeps every collect non-empty, so each collect
  // reaches the exporter.
  provider.getMeter('test').createCounter('requests').add(1);
  return {
    reader,
    provider,
    exporter,
    at(t: number) {
      time = t;
    },
  };
}

/** Lets fire-and-forget collects finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('RequestDrivenMetricReader', () => {
  const providers: MeterProvider[] = [];

  function harness(options: HarnessOptions = {}) {
    const created = createHarness({
      exportIntervalMillis: PERIOD,
      floorMillis: FLOOR,
      ...options,
    });
    providers.push(created.provider);
    return created;
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Promise.allSettled(providers.splice(0).map((p) => p.shutdown()));
  });

  describe('request lifecycle', () => {
    it('collects when a lone request ends', async () => {
      const {reader, exporter, at} = harness();

      at(0);
      reader.onRequestStart();
      at(10000);
      await reader.onRequestEnd();

      expect(exporter.exportTimes).toEqual([10000]);
    });

    it('batches overlapping requests into one collect at the last end', async () => {
      const {reader, exporter, at} = harness();

      at(0);
      reader.onRequestStart();
      at(1000);
      reader.onRequestStart();
      at(2000);
      await reader.onRequestEnd();
      at(10000);
      await reader.onRequestEnd();

      expect(exporter.exportTimes).toEqual([10000]);
    });

    it('collects at an overlapping start once a guidepost has passed', async () => {
      const {reader, exporter, at} = harness();

      at(0);
      reader.onRequestStart();
      at(1000);
      reader.onRequestStart();
      at(20000);
      await reader.onRequestEnd();
      at(PERIOD + 1000);
      reader.onRequestStart();
      await settle();

      expect(exporter.exportTimes).toEqual([PERIOD + 1000]);
    });

    it('does not collect at a start that does not overlap another request', async () => {
      const {reader, exporter, at} = harness();

      at(PERIOD * 3);
      reader.onRequestStart();
      await settle();

      expect(exporter.exportTimes).toEqual([]);
    });

    it('mutes a guidepost that lands within the floor of the last collect', async () => {
      const {reader, exporter, at} = harness();

      at(0);
      reader.onRequestStart();
      at(PERIOD - 2000);
      await reader.onRequestEnd();
      at(PERIOD - 1000);
      reader.onRequestStart();
      at(PERIOD + 1000);
      reader.onRequestStart();
      await settle();
      at(PERIOD + 4000);
      reader.onRequestStart();
      await settle();

      expect(exporter.exportTimes).toEqual([PERIOD - 2000]);
    });

    it('collects at a model-call start once a lone request is 1.5 periods long', async () => {
      const {reader, exporter, at} = harness();

      at(0);
      reader.onRequestStart();
      at(1.5 * PERIOD - 1);
      reader.onInferenceStart();
      await settle();
      expect(exporter.exportTimes).toEqual([]);

      at(1.5 * PERIOD);
      reader.onInferenceStart();
      await settle();
      expect(exporter.exportTimes).toEqual([1.5 * PERIOD]);
    });

    it('does not treat a short request after an idle gap as overdue', async () => {
      const {reader, exporter, at} = harness();

      at(0);
      reader.onRequestStart();
      at(10000);
      await reader.onRequestEnd();
      at(10 * PERIOD);
      reader.onRequestStart();
      at(10 * PERIOD + 1000);
      reader.onInferenceStart();
      await settle();
      at(10 * PERIOD + 2000);
      await reader.onRequestEnd();

      expect(exporter.exportTimes).toEqual([10000, 10 * PERIOD + 2000]);
    });

    it('does not collect at a model-call start with no request in flight', async () => {
      const {reader, exporter, at} = harness();

      at(10 * PERIOD);
      reader.onInferenceStart();
      await settle();

      expect(exporter.exportTimes).toEqual([]);
    });

    it('loses a short last request that ends within the floor of a collect', async () => {
      const {reader, exporter, at} = harness();

      at(0);
      reader.onRequestStart();
      at(10000);
      await reader.onRequestEnd();
      at(11000);
      reader.onRequestStart();
      at(12000);
      await reader.onRequestEnd();

      expect(exporter.exportTimes).toEqual([10000]);
    });

    it('resolves onRequestEnd only after a running collect has exported', async () => {
      const {reader, exporter, at} = harness();
      exporter.mode = 'hold';

      at(0);
      reader.onRequestStart();
      at(10000);
      let firstEnded = false;
      const firstEnd = reader.onRequestEnd().then(() => {
        firstEnded = true;
      });
      await settle();
      at(11000);
      reader.onRequestStart();
      at(12000);
      let secondEnded = false;
      const secondEnd = reader.onRequestEnd().then(() => {
        secondEnded = true;
      });
      await settle();
      expect(exporter.exportTimes).toEqual([10000]);
      expect(firstEnded).toBe(false);
      expect(secondEnded).toBe(false);

      exporter.mode = 'succeed';
      exporter.heldCallback?.({code: 0});
      await Promise.all([firstEnd, secondEnd]);
      expect(firstEnded).toBe(true);
      expect(secondEnded).toBe(true);
    });

    it('starts no timer and exports nothing while idle', async () => {
      vi.useFakeTimers({toFake: ['setTimeout', 'setInterval']});
      const {exporter} = harness();

      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);

      expect(exporter.exportTimes).toEqual([]);
    });
  });

  describe('failures', () => {
    it.each<ExportMode>(['fail', 'throw'])(
      'keeps collecting after an export that reports %s',
      async (mode) => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const {reader, exporter, at} = harness();
        exporter.mode = mode;

        at(0);
        reader.onRequestStart();
        at(10000);
        await expect(reader.onRequestEnd()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Request-driven metric export failed'),
        );

        exporter.mode = 'succeed';
        at(20000);
        reader.onRequestStart();
        at(30000);
        await reader.onRequestEnd();

        expect(exporter.exportTimes).toEqual([10000, 30000]);
      },
    );

    it('keeps collecting after an export that times out', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const {reader, exporter, at} = harness({exportTimeoutMillis: 20});
      exporter.mode = 'hang';

      at(0);
      reader.onRequestStart();
      at(10000);
      await reader.onRequestEnd();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));

      exporter.mode = 'succeed';
      at(20000);
      reader.onRequestStart();
      at(30000);
      await reader.onRequestEnd();

      expect(exporter.exportTimes).toEqual([10000, 30000]);
    });

    it('never throws from a hook when the clock throws', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      let broken = false;
      const exporter = new RecordingExporter(() => 0);
      const reader = new RequestDrivenMetricReader({
        exporter,
        now: () => {
          if (broken) {
            throw new Error('clock failed');
          }
          return 0;
        },
      });
      broken = true;

      expect(() => reader.onRequestStart()).not.toThrow();
      expect(() => reader.onInferenceStart()).not.toThrow();
      await expect(reader.onRequestEnd()).resolves.toBeUndefined();
    });
  });

  describe('configuration', () => {
    it('reads the period and the floor from the environment', async () => {
      vi.stubEnv('OTEL_METRIC_EXPORT_INTERVAL', '1000');
      vi.stubEnv(
        'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS',
        '100',
      );
      const {reader, exporter, at, provider} = createHarness();
      providers.push(provider);

      at(0);
      reader.onRequestStart();
      at(1500);
      reader.onInferenceStart();
      await settle();
      at(1600);
      await reader.onRequestEnd();
      at(1650);
      reader.onRequestStart();
      at(1700);
      await reader.onRequestEnd();

      expect(exporter.exportTimes).toEqual([1500, 1600, 1700]);
    });

    it('reads the export timeout from the environment', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.stubEnv('OTEL_METRIC_EXPORT_TIMEOUT', '20');
      const {reader, exporter, at, provider} = createHarness();
      providers.push(provider);
      exporter.mode = 'hang';

      at(0);
      reader.onRequestStart();
      at(10000);

      await expect(reader.onRequestEnd()).resolves.toBeUndefined();
    });

    it('uses the defaults when no option or variable is set', async () => {
      const {reader, exporter, at, provider} = createHarness();
      providers.push(provider);

      at(0);
      reader.onRequestStart();
      at(1.5 * PERIOD - 1);
      reader.onInferenceStart();
      await settle();
      at(1.5 * PERIOD);
      reader.onInferenceStart();
      await settle();
      at(1.5 * PERIOD + 4999);
      reader.onRequestStart();
      await reader.onRequestEnd();
      await reader.onRequestEnd();
      at(1.5 * PERIOD + 10000);
      reader.onRequestStart();
      await reader.onRequestEnd();

      expect(exporter.exportTimes).toEqual([
        1.5 * PERIOD,
        1.5 * PERIOD + 10000,
      ]);
    });

    it.each([
      'OTEL_METRIC_EXPORT_INTERVAL',
      'OTEL_METRIC_EXPORT_TIMEOUT',
      'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS',
    ])('warns about an invalid %s and uses its default', async (name) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.stubEnv(name, 'soon');
      const {reader, exporter, at, provider} = createHarness();
      providers.push(provider);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`invalid value for ${name}`),
      );
      at(0);
      reader.onRequestStart();
      at(PERIOD);
      reader.onInferenceStart();
      await settle();
      at(1.5 * PERIOD);
      reader.onInferenceStart();
      await settle();
      at(1.5 * PERIOD + 4999);
      await reader.onRequestEnd();

      expect(exporter.exportTimes).toEqual([1.5 * PERIOD]);
    });

    it('prefers an explicit option to the environment', async () => {
      vi.stubEnv('OTEL_METRIC_EXPORT_INTERVAL', '1000');
      const {reader, exporter, at} = harness();

      at(0);
      reader.onRequestStart();
      at(1500);
      reader.onInferenceStart();
      await settle();

      expect(exporter.exportTimes).toEqual([]);
    });

    it('takes aggregation temporality from the exporter', () => {
      const {reader} = harness({temporality: AggregationTemporality.DELTA});

      expect(reader.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(
        AggregationTemporality.DELTA,
      );
    });
  });

  describe('provider lifecycle', () => {
    it('installs the model-call hook when a provider registers it', async () => {
      const {reader, exporter, at} = harness();
      const hook: unknown = Reflect.get(globalThis, INFERENCE_START_HOOK_KEY);

      at(0);
      reader.onRequestStart();
      at(1.5 * PERIOD);
      expect(typeof hook).toBe('function');
      if (typeof hook === 'function') {
        hook();
      }
      await settle();

      expect(exporter.exportTimes).toEqual([1.5 * PERIOD]);
    });

    it('runs a final collect, shuts the exporter down and removes the hook on shutdown', async () => {
      const {provider, exporter, at} = createHarness({floorMillis: FLOOR});

      at(1000);
      await provider.shutdown();

      expect(exporter.exportTimes).toEqual([1000]);
      expect(exporter.shutdownCalls).toBe(1);
      expect(Reflect.get(globalThis, INFERENCE_START_HOOK_KEY)).toBeUndefined();
    });

    it('collects and flushes the exporter on forceFlush', async () => {
      const {reader, exporter, at} = harness();

      at(1000);
      await reader.forceFlush();

      expect(exporter.exportTimes).toEqual([1000]);
      expect(exporter.forceFlushCalls).toBe(1);
    });
  });
});
