/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';

import type {RetryConfig} from './config.js';
import type {EventRow} from './event_schema.js';

const logger = getLogger();

const GRPC_INVALID_ARGUMENT = 3;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_FAILED_PRECONDITION = 9;
const GRPC_INTERNAL = 13;
const GRPC_UNAVAILABLE = 14;
const GRPC_UNAUTHENTICATED = 16;

const DEFAULT_ATTEMPT_TIMEOUT_MS = 30000;

/** Result returned by the injected BigQuery row write seam. */
export interface AppendResult {
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
  };
  readonly rowErrors?: readonly unknown[];
}

/** Tally of dropped rows per reason. */
export interface DropStats {
  readonly queue_full: number;
  readonly encode_failed: number;
  readonly retry_exhausted: number;
  readonly non_retryable: number;
  readonly unexpected_error: number;
  readonly shutdown_timeout: number;
  readonly shutdown_cancelled: number;
  readonly permission_denied: number;
  readonly not_found: number;
  readonly setup_unavailable?: number;
  readonly shutdown_race?: number;
  readonly content_parse_failed?: number;
}

/** Internal error thrown on retryable in-band response error codes. */
export class RetryableWriteResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableWriteResponseError';
  }
}

/** Options for creating a {@link BatchProcessor}. */
export interface BatchProcessorOptions {
  /** The low-level write seam. */
  readonly writeRows: (rows: readonly EventRow[]) => Promise<AppendResult>;
  /** Number of rows to write per batch. */
  readonly batchSize?: number;
  /** Flush interval in seconds. */
  readonly flushInterval?: number;
  /** Retry configuration. */
  readonly retryConfig?: RetryConfig;
  /** Maximum queue size. */
  readonly queueMaxSize?: number;
  /** Maximum shutdown drain wait in seconds. */
  readonly shutdownTimeout?: number;
  /** Injectable random source returning a number in [0, 1). */
  readonly random?: () => number;
  /** Injectable sleep helper. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function extractErrorCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    if ('code' in err && typeof err.code === 'number') {
      return err.code;
    }
    if ('status' in err && typeof err.status === 'number') {
      return err.status;
    }
  }
  return undefined;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof err.message === 'string'
  ) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Write attempt timed out after ${ms}ms.`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Batches events, flushing on size and interval, and retries writes with backoff.
 */
export class BatchProcessor {
  private readonly writeRows: (
    rows: readonly EventRow[],
  ) => Promise<AppendResult>;
  private readonly batchSize: number;
  private readonly flushInterval: number;
  private readonly retryConfig: RetryConfig;
  private readonly queueMaxSize: number;
  private readonly shutdownTimeout: number;
  private readonly reservedTerminalSlots: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private queue: EventRow[] = [];
  private inFlightBatch: readonly EventRow[] = [];
  private isWriting = false;
  private isShutdown = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushWaiters: Array<() => void> = [];

  private readonly drops: Record<keyof DropStats, number> = {
    queue_full: 0,
    encode_failed: 0,
    retry_exhausted: 0,
    non_retryable: 0,
    unexpected_error: 0,
    shutdown_timeout: 0,
    shutdown_cancelled: 0,
    permission_denied: 0,
    not_found: 0,
    setup_unavailable: 0,
    shutdown_race: 0,
    content_parse_failed: 0,
  };

  constructor(options: BatchProcessorOptions) {
    this.writeRows = options.writeRows;
    this.batchSize = options.batchSize ?? 1;
    this.flushInterval = options.flushInterval ?? 1.0;
    this.retryConfig = options.retryConfig ?? {
      maxRetries: 3,
      initialDelay: 1.0,
      multiplier: 2.0,
      maxDelay: 10.0,
    };
    this.queueMaxSize = options.queueMaxSize ?? 10000;
    this.shutdownTimeout = options.shutdownTimeout ?? 10.0;
    this.random = options.random ?? Math.random;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    this.reservedTerminalSlots =
      this.queueMaxSize <= 1
        ? 0
        : Math.min(
            Math.max(2, Math.floor(this.queueMaxSize / 100)),
            this.queueMaxSize - 1,
          );
  }

  private recordDrop(reason: keyof DropStats, count: number = 1): void {
    this.drops[reason] += count;
  }

  /**
   * Appends an event row to the batching queue.
   */
  append(row: EventRow): void {
    if (this.isShutdown) {
      this.recordDrop('shutdown_cancelled', 1);
      logger.warn('Event rejected: BigQuery batch processor is shut down.');
      return;
    }

    const isTerminal =
      row.event_type === 'INVOCATION_COMPLETED' ||
      row.event_type === 'INVOCATION_ERROR';

    if (
      !isTerminal &&
      this.reservedTerminalSlots > 0 &&
      this.queue.length >= this.queueMaxSize - this.reservedTerminalSlots
    ) {
      this.recordDrop('queue_full', 1);
      logger.warn(
        'Event rejected: BigQuery queue full (reserved terminal slots preserved).',
      );
      return;
    }

    if (this.queue.length >= this.queueMaxSize) {
      this.recordDrop('queue_full', 1);
      logger.warn('Event rejected: BigQuery queue full.');
      return;
    }

    this.queue.push(row);

    if (this.queue.length >= this.batchSize) {
      void this.triggerWrite();
    } else if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.triggerWrite();
      }, this.flushInterval * 1000);
      this.flushTimer.unref();
    }
  }

  private notifyFlushWaiters(): void {
    if (
      this.queue.length === 0 &&
      !this.isWriting &&
      this.inFlightBatch.length === 0
    ) {
      const waiters = this.flushWaiters;
      this.flushWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  private async triggerWrite(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    if (this.isWriting) {
      return;
    }
    this.isWriting = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        this.inFlightBatch = batch;
        try {
          await this.writeRowsWithRetry(batch);
        } finally {
          this.inFlightBatch = [];
        }
      }
    } finally {
      this.isWriting = false;
      this.notifyFlushWaiters();
    }
  }

  private async writeRowsWithRetry(rows: readonly EventRow[]): Promise<void> {
    let attempt = 0;
    let delay = this.retryConfig.initialDelay;

    while (attempt <= this.retryConfig.maxRetries) {
      try {
        const result = await withTimeout(
          this.writeRows(rows),
          DEFAULT_ATTEMPT_TIMEOUT_MS,
        );

        if (
          result.error &&
          result.error.code !== undefined &&
          result.error.code !== 0
        ) {
          const code = result.error.code;
          const message = result.error.message ?? 'Unknown write error';

          if (
            code === GRPC_DEADLINE_EXCEEDED ||
            code === GRPC_INTERNAL ||
            code === GRPC_UNAVAILABLE
          ) {
            throw new RetryableWriteResponseError(message);
          }

          if (code === GRPC_PERMISSION_DENIED) {
            this.recordDrop('permission_denied', rows.length);
            logger.error(`BigQuery write permission denied: ${message}`);
            return;
          }

          if (code === GRPC_NOT_FOUND) {
            this.recordDrop('not_found', rows.length);
            logger.error(`BigQuery table or stream not found: ${message}`);
            return;
          }

          if (
            code === GRPC_INVALID_ARGUMENT ||
            code === GRPC_FAILED_PRECONDITION ||
            code === GRPC_UNAUTHENTICATED
          ) {
            if (message.toLowerCase().includes('schema mismatch')) {
              logger.error(`BigQuery schema mismatch: ${message}`);
            } else {
              logger.error(
                `Non-retryable BigQuery write error (${code}): ${message}`,
              );
            }
            this.recordDrop('non_retryable', rows.length);
            return;
          }

          // Other in-band error codes
          this.recordDrop('non_retryable', rows.length);
          logger.error(
            `Non-retryable BigQuery write error (${code}): ${message}`,
          );
          return;
        }

        // Successful write
        return;
      } catch (err: unknown) {
        const code = extractErrorCode(err);
        const message = extractErrorMessage(err);

        const isRetryable =
          err instanceof RetryableWriteResponseError ||
          (err instanceof Error && err.name === 'TimeoutError') ||
          code === GRPC_UNAVAILABLE ||
          code === GRPC_RESOURCE_EXHAUSTED ||
          code === GRPC_INTERNAL;

        if (isRetryable) {
          attempt += 1;
          if (attempt > this.retryConfig.maxRetries) {
            this.recordDrop('retry_exhausted', rows.length);
            logger.error(
              `BigQuery batch dropped after ${attempt} attempts: ${message}`,
            );
            return;
          }

          const sleepTime = Math.min(
            delay * (1 + this.random()),
            this.retryConfig.maxDelay,
          );
          logger.warn(
            `BigQuery write failed (attempt ${attempt}), retrying in ${sleepTime.toFixed(2)}s: ${message}`,
          );
          await this.sleep(sleepTime * 1000);
          delay = Math.min(
            delay * this.retryConfig.multiplier,
            this.retryConfig.maxDelay,
          );
          continue;
        }

        if (code === GRPC_PERMISSION_DENIED) {
          this.recordDrop('permission_denied', rows.length);
          logger.error(`BigQuery write permission denied: ${message}`);
          return;
        }

        if (code === GRPC_NOT_FOUND) {
          this.recordDrop('not_found', rows.length);
          logger.error(`BigQuery table not found: ${message}`);
          return;
        }

        if (
          code === GRPC_INVALID_ARGUMENT ||
          code === GRPC_FAILED_PRECONDITION ||
          code === GRPC_UNAUTHENTICATED
        ) {
          if (message.toLowerCase().includes('schema mismatch')) {
            logger.error(`BigQuery schema mismatch: ${message}`);
          } else {
            logger.error(
              `Non-retryable BigQuery write error (${code}): ${message}`,
            );
          }
          this.recordDrop('non_retryable', rows.length);
          return;
        }

        this.recordDrop('unexpected_error', rows.length);
        logger.error(`Unexpected BigQuery write error: ${message}`);
        return;
      }
    }
  }

  /**
   * Flushes all queued rows and waits for in-flight writes to complete.
   */
  async flush(): Promise<void> {
    if (
      this.queue.length === 0 &&
      !this.isWriting &&
      this.inFlightBatch.length === 0
    ) {
      return;
    }

    const flushPromise = new Promise<void>((resolve) => {
      this.flushWaiters.push(resolve);
    });

    void this.triggerWrite();
    return flushPromise;
  }

  /**
   * Shuts down the processor, draining remaining rows within the deadline.
   */
  async shutdown(timeoutSeconds: number = this.shutdownTimeout): Promise<void> {
    if (this.isShutdown) {
      return;
    }
    this.isShutdown = true;

    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    const timeoutMs = timeoutSeconds * 1000;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      timer.unref();
    });

    await Promise.race([this.flush(), timeoutPromise]);

    if (timer !== undefined) {
      clearTimeout(timer);
    }

    if (timedOut) {
      const abandoned = this.inFlightBatch.length + this.queue.length;
      this.queue = [];
      if (abandoned > 0) {
        this.recordDrop('shutdown_timeout', abandoned);
        logger.warn(
          `BigQuery batch processor shutdown timed out; abandoned ${abandoned} row(s).`,
        );
      }
    }
  }

  /**
   * Returns a copy of the drop statistics counters.
   */
  getDropStats(): DropStats {
    return {...this.drops};
  }
}
