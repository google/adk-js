/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MeterProvider,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import fc from 'fast-check';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {RequestDrivenMetricReader} from '../../src/telemetry/export/request_driven_metric_reader.js';
import {logger} from '../../src/utils/logger.js';

/**
 * Keeps every request longer than the floor, so a collect always lands
 * strictly before its request's end, and absorbs float error at that boundary.
 */
const LENGTH_MARGIN = 10;
const EPSILON = 1e-6;
const MAX_REQUESTS = 40;
const MAX_MODEL_CALLS = 4;
const FAST_CHECK_OPTIONS = {seed: 20260611, numRuns: 120};

type ExportCallback = Parameters<PushMetricExporter['export']>[1];

/** Records the clock time of every export, failing when `shouldFail` says so. */
class RecordingExporter implements PushMetricExporter {
  readonly exportTimes: number[] = [];

  constructor(
    private readonly now: () => number,
    private readonly shouldFail: () => boolean = () => false,
  ) {}

  export(_metrics: ResourceMetrics, resultCallback: ExportCallback): void {
    this.exportTimes.push(this.now());
    if (this.shouldFail()) {
      resultCallback({code: 1, error: new Error('backend unavailable')});
      return;
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

interface Request {
  readonly start: number;
  readonly end: number;
  readonly modelCalls: readonly number[];
}

interface Workload {
  readonly period: number;
  readonly floor: number;
  readonly requests: readonly Request[];
}

type EventKind = 'start' | 'model' | 'end';

/** Equal times replay as start, then model call, then end. */
const EVENT_ORDER: Readonly<Record<EventKind, number>> = {
  start: 0,
  model: 1,
  end: 2,
};

interface TimelineEvent {
  readonly t: number;
  readonly kind: EventKind;
}

/** What the replay saw at one event. */
interface Observation extends TimelineEvent {
  /** Requests in flight just before the event. */
  readonly inFlightBefore: number;
  /** The start of the busy period the event falls in. */
  readonly busyStart: number;
  /** The last collect before the event, if any. */
  readonly lastCollect?: number;
  /** Whether the event triggered a collect. */
  readonly collected: boolean;
}

/**
 * Workloads described by their shape: request count, mean length and its
 * spread, concurrency (the mean gap between arrivals is the mean length over
 * the concurrency), the spread of arrival gaps, and model calls per request.
 * Model calls land at least the floor before their request's end.
 */
const workloadArbitrary: fc.Arbitrary<Workload> = fc
  .record({
    floor: fc.integer({min: 1000, max: 10000}),
    periodOverFloor: fc.double({min: 1, max: 30, noNaN: true}),
    meanLength: fc.double({min: 0, max: 300000, noNaN: true}),
    concurrency: fc.double({min: 0.1, max: 10, noNaN: true}),
    shapes: fc.array(
      fc.record({
        gapFactor: fc.double({min: 0, max: 2, noNaN: true}),
        lengthFactor: fc.double({min: 0, max: 2, noNaN: true}),
        modelCalls: fc.array(fc.double({min: 0, max: 1, noNaN: true}), {
          maxLength: MAX_MODEL_CALLS,
        }),
      }),
      {maxLength: MAX_REQUESTS},
    ),
  })
  .map(({floor, periodOverFloor, meanLength, concurrency, shapes}) => {
    const minLength = floor + LENGTH_MARGIN;
    const meanGap = (minLength + meanLength) / concurrency;
    let t = 0;
    const requests = shapes.map(({gapFactor, lengthFactor, modelCalls}) => {
      t += gapFactor * meanGap;
      const length = minLength + lengthFactor * meanLength;
      const modelSpan = length - floor - LENGTH_MARGIN;
      return {
        start: t,
        end: t + length,
        modelCalls: modelCalls.map((fraction) => t + fraction * modelSpan),
      };
    });
    return {floor, period: floor * periodOverFloor, requests};
  });

function timelineOf(requests: readonly Request[]): TimelineEvent[] {
  return requests
    .flatMap((request): TimelineEvent[] => [
      {t: request.start, kind: 'start'},
      ...request.modelCalls.map((t): TimelineEvent => ({t, kind: 'model'})),
      {t: request.end, kind: 'end'},
    ])
    .sort((a, b) => a.t - b.t || EVENT_ORDER[a.kind] - EVENT_ORDER[b.kind]);
}

/** Lets fire-and-forget collects finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

interface Replay {
  readonly reader: RequestDrivenMetricReader;
  readonly exporter: RecordingExporter;
  readonly provider: MeterProvider;
  at(t: number): void;
}

function createReplay({
  period,
  floor,
  shouldFail,
}: {
  period: number;
  floor: number;
  shouldFail?: () => boolean;
}): Replay {
  let time = 0;
  const now = () => time;
  const exporter = new RecordingExporter(now, shouldFail);
  const reader = new RequestDrivenMetricReader({
    exporter,
    now,
    exportIntervalMillis: period,
    floorMillis: floor,
  });
  const provider = new MeterProvider({readers: [reader]});
  provider.getMeter('test').createCounter('requests').add(1);
  return {
    reader,
    exporter,
    provider,
    at(t: number) {
      time = t;
    },
  };
}

/** Replays `workload` through a real reader on a real provider. */
async function simulate(workload: Workload): Promise<{
  observations: Observation[];
  collects: number[];
}> {
  const {reader, exporter, provider, at} = createReplay(workload);
  const observations: Observation[] = [];
  let inFlight = 0;
  let busyStart = 0;
  try {
    for (const {t, kind} of timelineOf(workload.requests)) {
      at(t);
      const exportsBefore = exporter.exportTimes.length;
      const inFlightBefore = inFlight;
      if (kind === 'start') {
        if (inFlight === 0) {
          busyStart = t;
        }
        inFlight += 1;
        reader.onRequestStart();
        await settle();
      } else if (kind === 'model') {
        reader.onInferenceStart();
        await settle();
      } else {
        inFlight -= 1;
        await reader.onRequestEnd();
      }
      observations.push({
        t,
        kind,
        inFlightBefore,
        busyStart,
        lastCollect: exporter.exportTimes.at(exportsBefore - 1),
        collected: exporter.exportTimes.length > exportsBefore,
      });
    }
    return {observations, collects: [...exporter.exportTimes]};
  } finally {
    await provider.shutdown();
  }
}

/** Merges overlapping or touching request windows into busy periods. */
function busyPeriods(requests: readonly Request[]): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const {start, end} of [...requests].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

describe('RequestDrivenMetricReader invariants', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collects only while a request is in flight (I1)', async () => {
    await fc.assert(
      fc.asyncProperty(workloadArbitrary, async (workload) => {
        const {collects} = await simulate(workload);
        for (const t of collects) {
          expect(
            workload.requests.some(({start, end}) => start <= t && t <= end),
          ).toBe(true);
        }
      }),
      FAST_CHECK_OPTIONS,
    );
  });

  it('never collects twice within the floor (I2)', async () => {
    await fc.assert(
      fc.asyncProperty(workloadArbitrary, async (workload) => {
        const {collects} = await simulate(workload);
        for (let i = 1; i < collects.length; i++) {
          expect(collects[i] - collects[i - 1]).toBeGreaterThanOrEqual(
            workload.floor - EPSILON,
          );
        }
      }),
      FAST_CHECK_OPTIONS,
    );
  });

  it('collects at an overlapping start a period plus the floor after the last collect (I3)', async () => {
    await fc.assert(
      fc.asyncProperty(workloadArbitrary, async (workload) => {
        const {observations} = await simulate(workload);
        for (const event of observations) {
          if (event.kind !== 'start' || event.inFlightBefore === 0) {
            continue;
          }
          const since = event.lastCollect ?? 0;
          if (event.t - since >= workload.period + workload.floor) {
            expect(event.collected, `start at ${event.t}`).toBe(true);
          }
        }
      }),
      FAST_CHECK_OPTIONS,
    );
  });

  it('collects at a model call 1.5 periods into an uncollected busy period (I3)', async () => {
    await fc.assert(
      fc.asyncProperty(workloadArbitrary, async (workload) => {
        const {observations} = await simulate(workload);
        for (const event of observations) {
          if (event.kind !== 'model') {
            continue;
          }
          const since = Math.max(
            event.busyStart,
            event.lastCollect ?? -Infinity,
          );
          if (event.t - since >= 1.5 * workload.period) {
            expect(event.collected, `model call at ${event.t}`).toBe(true);
          }
        }
      }),
      FAST_CHECK_OPTIONS,
    );
  });

  it('collects after every request end before in-flight returns to zero', async () => {
    await fc.assert(
      fc.asyncProperty(workloadArbitrary, async (workload) => {
        const {collects} = await simulate(workload);
        const periods = busyPeriods(workload.requests);
        for (const {end} of workload.requests) {
          const period = periods.find(([s, e]) => s <= end && end <= e);
          expect(period).toBeDefined();
          const periodEnd = period?.[1] ?? end;
          expect(
            collects.some((t) => end <= t && t <= periodEnd),
            `request ending at ${end}`,
          ).toBe(true);
        }
      }),
      FAST_CHECK_OPTIONS,
    );
  });

  it('keeps request accounting balanced under any interleaving and failing exports', async () => {
    const interleaving = fc.record({
      floor: fc.integer({min: 1, max: 5000}),
      period: fc.integer({min: 1, max: 60000}),
      steps: fc.array(
        fc.record({
          action: fc.constantFrom<EventKind>('start', 'model', 'end'),
          advance: fc.integer({min: 0, max: 20000}),
          fail: fc.boolean(),
        }),
        {maxLength: 80},
      ),
    });

    await fc.assert(
      fc.asyncProperty(interleaving, async ({floor, period, steps}) => {
        let fail = false;
        const {reader, exporter, provider, at} = createReplay({
          period,
          floor,
          shouldFail: () => fail,
        });
        try {
          let t = 0;
          let open = 0;
          for (const step of steps) {
            t += step.advance;
            at(t);
            fail = step.fail;
            if (step.action === 'start') {
              open += 1;
              reader.onRequestStart();
              await settle();
            } else if (step.action === 'model') {
              reader.onInferenceStart();
              await settle();
            } else if (open > 0) {
              open -= 1;
              await reader.onRequestEnd();
            }
          }
          for (; open > 0; open--) {
            await reader.onRequestEnd();
          }

          fail = false;
          at(t + 1);
          reader.onRequestStart();
          await settle();
          const exportsBefore = exporter.exportTimes.length;
          at(t + 1 + floor);
          await reader.onRequestEnd();

          expect(exporter.exportTimes.length - exportsBefore).toBe(1);
        } finally {
          await provider.shutdown();
        }
      }),
      FAST_CHECK_OPTIONS,
    );
  });
});
