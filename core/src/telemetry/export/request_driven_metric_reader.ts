/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, createContextKey} from '@opentelemetry/api';
import {
  MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/**
 * The minimum spacing, in milliseconds, between two metric exports to
 * telemetry.googleapis.com.
 *
 * Every ADK metric reader that exports there stays at or above it: it is the
 * default floor of {@link RequestDrivenMetricReader} and the export interval of
 * the periodic reader. The backend tolerates slightly faster points to absorb
 * drift, but that is not a supported rate.
 */
export const MIN_EXPORT_INTERVAL_MS = 5000;

const FLOOR_ENV_VAR =
  'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS';
const EXPORT_INTERVAL_ENV_VAR = 'OTEL_METRIC_EXPORT_INTERVAL';
const EXPORT_TIMEOUT_ENV_VAR = 'OTEL_METRIC_EXPORT_TIMEOUT';
const DEFAULT_EXPORT_INTERVAL_MS = 60000;
const DEFAULT_EXPORT_TIMEOUT_MS = 30000;

/**
 * How many export periods a busy period may run without a collect before a
 * model-call start forces one.
 */
const OVERDUE_PERIODS = 1.5;

/**
 * The process-global slot that the model-call instrumentation reads on each
 * `generate_content` start. `telemetry/api` owns the reading side and may not
 * be imported from here, so this key repeats the one in
 * `telemetry/api/internal/metrics/inference_start_hook.ts` and must stay
 * identical to it.
 */
const INFERENCE_START_HOOK_KEY = Symbol.for(
  'google.adk.telemetry.inferenceStartHook',
);

/**
 * The context key the OpenTelemetry SDK reads to suppress tracing. Exporting
 * with it set keeps the HTTP export itself from producing spans. The SDK
 * creates the key from this description in `@opentelemetry/core`, which is not
 * a dependency of this package; keep the string in step with it.
 */
const SUPPRESS_TRACING_KEY = createContextKey(
  'OpenTelemetry SDK Context Key SUPPRESS_TRACING',
);

/** The `ExportResultCode.SUCCESS` value of `@opentelemetry/core`. */
const EXPORT_RESULT_SUCCESS = 0;

const REQUEST_DRIVEN_METRIC_READER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.requestDrivenMetricReader',
);

type ExportResult = Parameters<Parameters<PushMetricExporter['export']>[1]>[0];

/** Options for {@link RequestDrivenMetricReader}. */
export interface RequestDrivenMetricReaderOptions {
  /** The exporter each collect is sent to. */
  readonly exporter: PushMetricExporter;
  /**
   * The spacing of the guidepost grid, in milliseconds. Defaults to
   * `OTEL_METRIC_EXPORT_INTERVAL`, or 60000.
   */
  readonly exportIntervalMillis?: number;
  /**
   * The timeout of one collect and one export, in milliseconds. Defaults to
   * `OTEL_METRIC_EXPORT_TIMEOUT`, or 30000.
   */
  readonly exportTimeoutMillis?: number;
  /**
   * The minimum spacing between two collects, in milliseconds. Defaults to
   * `GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS`, or
   * `MIN_EXPORT_INTERVAL_MS`.
   */
  readonly floorMillis?: number;
  /** A monotonic millisecond clock. Defaults to `performance.now`. */
  readonly now?: () => number;
}

/**
 * Returns whether `obj` is a {@link RequestDrivenMetricReader}, including one
 * from another copy of this package.
 */
export function isRequestDrivenMetricReader(
  obj: unknown,
): obj is RequestDrivenMetricReader {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    REQUEST_DRIVEN_METRIC_READER_SIGNATURE_SYMBOL in obj
  );
}

/**
 * A metric reader that collects and exports only from the request path, with
 * no background timer.
 *
 * On a runtime that bills per request, such as Agent Runtime, the CPU is
 * throttled as soon as a request ends. A periodic reader's timer gets no CPU
 * between requests, so its exports are delayed or dropped. This reader keeps
 * three invariants instead:
 *
 * - I1, export only while serving: every collect runs while a request is in
 *   flight, the only time the CPU is guaranteed.
 * - I2, a floor: two collects are never closer than `floorMillis`.
 * - I3, a guidepost: the export period is a grid of hint times, not a
 *   schedule. Under sustained load a passed guidepost forces a collect, so
 *   points cannot pile up.
 *
 * Collects are triggered by:
 *
 * - {@link onRequestEnd}, when the last request in flight ends and the floor
 *   allows it (the drain).
 * - {@link onRequestStart}, when the request overlaps another one and a
 *   guidepost has passed. A guidepost that lands within the floor of the last
 *   collect is muted, and the grid moves one period on.
 * - The start of a model call, when 1.5 periods have passed since the later
 *   of the start of the busy period and the last collect. The model-call
 *   instrumentation calls this through a hook the reader installs when a
 *   `MeterProvider` registers it.
 *
 * Residual loss case: a request shorter than the floor that ends right after
 * a collect has its drain muted by the floor. If it is the last request
 * before the process goes idle, no later collect comes and its points are
 * lost.
 *
 * The defaults come from `OTEL_METRIC_EXPORT_INTERVAL` (60000),
 * `OTEL_METRIC_EXPORT_TIMEOUT` (30000) and
 * `GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS` (5000). An
 * explicit option wins over its variable. A value that is not a valid number
 * logs a warning and uses the default.
 *
 * None of the request methods throws or rejects.
 */
export class RequestDrivenMetricReader extends MetricReader {
  readonly [REQUEST_DRIVEN_METRIC_READER_SIGNATURE_SYMBOL] = true;

  private readonly exporter: PushMetricExporter;
  private readonly now: () => number;
  private readonly periodMillis: number;
  private readonly exportTimeoutMillis: number;
  private readonly floorMillis: number;
  private readonly inferenceStartHook = (): void => this.onInferenceStart();

  private inFlight = 0;
  private lastCollect?: number;
  /** When in-flight last went from zero to one. */
  private busyStart?: number;
  private nextDue: number;
  /** The collect now running; set while one runs, so collects never overlap. */
  private runningCollect?: Promise<void>;
  private isShutdown = false;

  constructor({
    exporter,
    exportIntervalMillis,
    exportTimeoutMillis,
    floorMillis,
    now = () => performance.now(),
  }: RequestDrivenMetricReaderOptions) {
    super({
      aggregationSelector: exporter.selectAggregation?.bind(exporter),
      aggregationTemporalitySelector:
        exporter.selectAggregationTemporality?.bind(exporter),
    });
    this.exporter = exporter;
    this.now = now;
    this.periodMillis = resolveMillis({
      name: EXPORT_INTERVAL_ENV_VAR,
      explicit: exportIntervalMillis,
      fallback: DEFAULT_EXPORT_INTERVAL_MS,
      allowZero: false,
    });
    this.exportTimeoutMillis = resolveMillis({
      name: EXPORT_TIMEOUT_ENV_VAR,
      explicit: exportTimeoutMillis,
      fallback: DEFAULT_EXPORT_TIMEOUT_MS,
      allowZero: false,
    });
    this.floorMillis = resolveMillis({
      name: FLOOR_ENV_VAR,
      explicit: floorMillis,
      fallback: MIN_EXPORT_INTERVAL_MS,
      allowZero: true,
    });
    this.nextDue = this.now() + this.periodMillis;
  }

  /** Marks a request as started, and collects if a guidepost has passed. */
  onRequestStart(): void {
    try {
      const now = this.now();
      const overlap = this.inFlight >= 1;
      if (!overlap) {
        this.busyStart = now;
      }
      this.inFlight += 1;
      if (!this.canCollect() || !overlap || now < this.nextDue) {
        return;
      }
      if (this.floorAllows(now)) {
        this.startCollect(now);
        return;
      }
      this.nextDue += this.periodMillis;
    } catch (error: unknown) {
      logger.warn(`Metric request-start hook failed: ${formatError(error)}`);
    }
  }

  /**
   * Marks a request as ended. Collects when no request is left in flight and
   * the floor allows it, and resolves once any running collect has exported.
   */
  async onRequestEnd(): Promise<void> {
    try {
      const now = this.now();
      this.inFlight = Math.max(0, this.inFlight - 1);
      if (this.inFlight === 0 && this.canCollect() && this.floorAllows(now)) {
        this.startCollect(now);
      }
    } catch (error: unknown) {
      logger.warn(`Metric request-end hook failed: ${formatError(error)}`);
    }
    await this.runningCollect;
  }

  /** Collects at a model-call start if the busy period is overdue. */
  onInferenceStart(): void {
    try {
      const now = this.now();
      if (
        this.canCollect() &&
        this.inFlight >= 1 &&
        this.isOverdue(now) &&
        this.floorAllows(now)
      ) {
        this.startCollect(now);
      }
    } catch (error: unknown) {
      logger.warn(`Metric model-call hook failed: ${formatError(error)}`);
    }
  }

  /** Registers the model-call start hook when a provider initializes this reader. */
  protected override onInitialized(): void {
    Reflect.set(globalThis, INFERENCE_START_HOOK_KEY, this.inferenceStartHook);
  }

  /** Shuts down the reader, exports remaining metrics, and cleans up hooks. */
  protected override async onShutdown(): Promise<void> {
    this.isShutdown = true;
    if (
      Reflect.get(globalThis, INFERENCE_START_HOOK_KEY) ===
      this.inferenceStartHook
    ) {
      Reflect.deleteProperty(globalThis, INFERENCE_START_HOOK_KEY);
    }
    await this.runningCollect;
    await this.runExclusive();
    await this.exporter.shutdown();
  }

  /** Flushes any in-flight and pending metric exports. */
  protected override async onForceFlush(): Promise<void> {
    await this.runningCollect;
    await this.runExclusive();
    await this.exporter.forceFlush();
  }

  private canCollect(): boolean {
    return this.runningCollect === undefined && !this.isShutdown;
  }

  private floorAllows(now: number): boolean {
    return (
      this.lastCollect === undefined ||
      now - this.lastCollect >= this.floorMillis
    );
  }

  /**
   * Returns whether the current busy period has gone 1.5 periods without a
   * collect. A collect from an earlier busy period does not count, so a short
   * request after an idle gap is never overdue: collecting at its model call
   * would set the floor and mute the drain that carries its points.
   */
  private isOverdue(now: number): boolean {
    if (this.busyStart === undefined) {
      return false;
    }
    const since = Math.max(this.busyStart, this.lastCollect ?? -Infinity);
    return now - since >= OVERDUE_PERIODS * this.periodMillis;
  }

  /** Starts a collect, and moves the guidepost grid past `now`. */
  private startCollect(now: number): void {
    if (now >= this.nextDue) {
      const missed = Math.floor((now - this.nextDue) / this.periodMillis) + 1;
      this.nextDue += missed * this.periodMillis;
    }
    this.lastCollect = now;
    void this.runExclusive();
  }

  /** Runs one collect and export as the running collect. Never rejects. */
  private runExclusive(): Promise<void> {
    const run = this.collectAndExport().finally(() => {
      if (this.runningCollect === run) {
        this.runningCollect = undefined;
      }
    });
    this.runningCollect = run;
    return run;
  }

  private async collectAndExport(): Promise<void> {
    try {
      const {resourceMetrics, errors} = await this.collect({
        timeoutMillis: this.exportTimeoutMillis,
      });
      for (const error of errors) {
        logger.warn(`Metric collection reported: ${formatError(error)}`);
      }
      if (resourceMetrics.resource.asyncAttributesPending) {
        await resourceMetrics.resource.waitForAsyncAttributes?.();
      }
      if (resourceMetrics.scopeMetrics.length === 0) {
        return;
      }
      await this.export(resourceMetrics);
    } catch (error: unknown) {
      logger.warn(`Request-driven metric export failed: ${formatError(error)}`);
    }
  }

  private async export(resourceMetrics: ResourceMetrics): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Metric export timed out after ${this.exportTimeoutMillis} ms.`,
          ),
        );
      }, this.exportTimeoutMillis);
    });
    const exported = new Promise<ExportResult>((resolve) => {
      context.with(context.active().setValue(SUPPRESS_TRACING_KEY, true), () =>
        this.exporter.export(resourceMetrics, resolve),
      );
    });
    try {
      const result = await Promise.race([exported, timedOut]);
      if (result.code !== EXPORT_RESULT_SUCCESS) {
        throw new Error(
          `Metric exporter reported a failure: ${formatError(result.error)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ResolveMillisParams {
  readonly name: string;
  readonly explicit: number | undefined;
  readonly fallback: number;
  readonly allowZero: boolean;
}

/**
 * Returns the explicit value, else the environment variable, else the
 * fallback. A value that is not a finite number in range logs a warning and
 * yields the fallback.
 */
function resolveMillis({
  name,
  explicit,
  fallback,
  allowZero,
}: ResolveMillisParams): number {
  const raw = explicit ?? process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = typeof raw === 'number' ? raw : Number(raw.trim() || NaN);
  const inRange = allowZero ? value >= 0 : value > 0;
  if (Number.isFinite(value) && inRange) {
    return value;
  }
  logger.warn(
    `Found invalid value for ${name}=${JSON.stringify(raw)}, using default ${fallback}.`,
  );
  return fallback;
}
