/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type TableField} from '@google-cloud/bigquery';
import {type managedwriter} from '@google-cloud/bigquery-storage';
import {logger} from '@google/adk';
import {type RetryConfig} from './config.js';
import {
  DROP_REASONS,
  type DropReason,
  type DropStats,
  type EventRow,
} from './types.js';
import {
  AppendAbortedError,
  type AppendRowsOutcome,
  createStorageRowAppender,
  defaultStreamName,
  type EncodedRow,
  type EncodedValue,
  GRPC_CODE,
  type RowAppender,
  RowEncodingError,
  WRITER_TRACE_ID,
} from './write_client.js';

const APPEND_TIMEOUT_SECONDS = 30;
const ROTATION_BACKOFF_SECONDS = 30;
const FINALIZE_TIMEOUT_SECONDS = 30;
/** Stream connections idle this long are closed so the process can exit. */
const IDLE_CONNECTION_SECONDS = 10;

/** Rows that always keep reserved queue capacity, so a turn can complete. */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'INVOCATION_COMPLETED',
  'INVOCATION_ERROR',
]);

/**
 * The local AppendRows deadline elapsed, or the stream ended without a
 * response; the outcome is unknown.
 */
export class AppendTimeoutError extends Error {
  override readonly name = 'AppendTimeoutError';

  constructor(message = 'BigQuery append timed out') {
    super(message);
  }
}

class RetryableWriteResponseError extends Error {
  override readonly name = 'RetryableWriteResponseError';
}

class WorkerCancelledError extends Error {
  override readonly name = 'WorkerCancelledError';
}

const SHUTDOWN_SENTINEL = Symbol('shutdown');
const TIMED_OUT = Symbol('timed-out');
const WORKER_CANCELLED = Symbol('worker-cancelled');

type QueueItem = EventRow | typeof SHUTDOWN_SENTINEL;

const RETRYABLE_RAISED_CODES: ReadonlySet<number> = new Set([
  GRPC_CODE.UNAVAILABLE,
  GRPC_CODE.RESOURCE_EXHAUSTED,
  GRPC_CODE.INTERNAL,
]);
const RETRYABLE_IN_BAND_CODES: ReadonlySet<number> = new Set([
  GRPC_CODE.DEADLINE_EXCEEDED,
  GRPC_CODE.INTERNAL,
  GRPC_CODE.UNAVAILABLE,
]);
const NON_RETRYABLE_RAISED_CODES: ReadonlySet<number> = new Set([
  GRPC_CODE.UNAUTHENTICATED,
  GRPC_CODE.INVALID_ARGUMENT,
  GRPC_CODE.FAILED_PRECONDITION,
]);

const HTTP_TO_GRPC_CODE: ReadonlyMap<number, number> = new Map([
  [403, GRPC_CODE.PERMISSION_DENIED],
  [404, GRPC_CODE.NOT_FOUND],
]);

/** The gRPC status of an error, mapping HTTP 403 / 404 from REST layers. */
function grpcCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  if (typeof error.code !== 'number') {
    return null;
  }
  return HTTP_TO_GRPC_CODE.get(error.code) ?? error.code;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/** JSON text for `value`; a JSON string of `String(value)` when unencodable. */
function stringifyOrString(value: unknown): string {
  try {
    // JSON.stringify returns undefined for undefined, functions and symbols
    // despite its typing.
    const text = JSON.stringify(value) as string | undefined;
    if (text !== undefined) {
      return text;
    }
  } catch {
    // Falls through to the string form.
  }
  return JSON.stringify(String(value));
}

/**
 * JSON columns travel as JSON text; a string that already holds a JSON object
 * or array is kept as-is.
 */
function encodeJsonValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString('utf8');
    return isJsonContainerText(text) ? text : stringifyOrString(text);
  }
  return stringifyOrString(value);
}

function encodeScalar(value: unknown): EncodedValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }
  try {
    return (JSON.stringify(value) as string | undefined) ?? String(value);
  } catch {
    return String(value);
  }
}

function encodeField(field: TableField, value: unknown): EncodedValue {
  const isRecordField = field.type === 'RECORD' || field.type === 'STRUCT';
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item: unknown) => {
      if (isRecordField) {
        return encodeRecord(field.fields ?? [], item);
      }
      return field.type === 'JSON' ? encodeJsonValue(item) : encodeScalar(item);
    });
  }
  if (isRecordField) {
    return value === null || value === undefined
      ? null
      : encodeRecord(field.fields ?? [], value);
  }
  return field.type === 'JSON' ? encodeJsonValue(value) : encodeScalar(value);
}

function encodeRecord(
  fields: ReadonlyArray<TableField>,
  value: unknown,
): EncodedRow {
  if (!isRecord(value)) {
    throw new TypeError('Expected an object for a RECORD field.');
  }
  return Object.fromEntries(
    fields.flatMap((field): Array<[string, EncodedValue]> => {
      const {name} = field;
      if (name === undefined || value[name] === undefined) {
        return [];
      }
      return [[name, encodeField(field, value[name])]];
    }),
  );
}

function isSchemaMismatch(message: string): boolean {
  return message.toLowerCase().includes('schema mismatch');
}

function isJsonContainerText(text: string): boolean {
  const stripped = text.trim();
  if (
    !(stripped.startsWith('{') || stripped.startsWith('[')) ||
    !(stripped.endsWith('}') || stripped.endsWith(']'))
  ) {
    return false;
  }
  try {
    JSON.parse(stripped);
    return true;
  } catch {
    return false;
  }
}

/**
 * The batch indices named by `rowErrors` when they identify a strict subset of
 * the batch; `undefined` when the rest of the batch cannot be resent safely.
 */
function rejectedRowIndices(
  rowErrors: ReadonlyArray<object> | null | undefined,
  rowCount: number,
): ReadonlySet<number> | undefined {
  if (!rowErrors || rowErrors.length === 0) {
    return undefined;
  }
  const indices = new Set<number>();
  for (const rowError of rowErrors) {
    const index = Number((rowError as {index?: unknown}).index);
    if (!Number.isInteger(index) || index < 0 || index >= rowCount) {
      return undefined;
    }
    indices.add(index);
  }
  return indices.size < rowCount ? indices : undefined;
}

function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WorkerCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, seconds * 1000);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      reject(new WorkerCancelledError());
    }
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

/**
 * Settles with `promise`, or rejects when `seconds` elapse or `signal` aborts
 * first.
 */
async function withDeadline<T>({
  promise,
  seconds,
  signal,
}: {
  promise: Promise<T>;
  seconds: number;
  signal: AbortSignal;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupt: ((error: Error) => void) | undefined;
  function onAbort(): void {
    rejectInterrupt?.(new WorkerCancelledError());
  }
  const interrupt = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
    if (signal.aborted) {
      reject(new WorkerCancelledError());
      return;
    }
    timer = setTimeout(() => {
      reject(new AppendTimeoutError());
    }, seconds * 1000);
    signal.addEventListener('abort', onAbort, {once: true});
  });
  try {
    return await Promise.race([promise, interrupt]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Resolves `true` when `promise` settles first, `false` when `seconds` elapse
 * or `signal` aborts.
 */
async function settlesWithin(
  promise: Promise<void>,
  seconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const settled = promise.then(
    () => true,
    () => true,
  );
  const timedOut = new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    timer = setTimeout(
      () => {
        resolve(false);
      },
      Math.max(0, seconds) * 1000,
    );
    onAbort = () => resolve(false);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function monotonicSeconds(): number {
  return performance.now() / 1000;
}

type Transport =
  | {
      writeClient: managedwriter.WriterClient;
      /** The processor may recycle the client's stream connections. */
      ownsWriteClient?: boolean;
      appender?: undefined;
    }
  | {appender: RowAppender; writeClient?: undefined};

export type BatchProcessorParams = Transport & {
  schema: Array<TableField>;
  destinationTable: string;
  writeStream?: string;
  batchSize: number;
  flushInterval: number;
  retryConfig: RetryConfig;
  queueMaxSize: number;
  shutdownTimeout: number;
  exactlyOnceDelivery: boolean;
  createStream?: () => Promise<string>;
};

/**
 * Asynchronous batching writer for the events table. Durations are in seconds.
 */
export class BatchProcessor {
  private readonly appender: RowAppender;
  private readonly schema: Array<TableField>;
  private writeStream: string;
  private readonly batchSize: number;
  private readonly flushInterval: number;
  private readonly retryConfig: RetryConfig;
  private readonly queueMaxSize: number;
  private readonly shutdownTimeout: number;
  private readonly exactlyOnceDelivery: boolean;
  private readonly createStream: (() => Promise<string>) | undefined;

  private nextOffset = 0;
  private offsetDesynced = false;
  private rotationRetryAt = 0;
  private streamFinalized = false;
  private readonly pendingFinalizeStreams = new Set<string>();
  private finalizeChain: Promise<void> = Promise.resolve();
  /** Aborted when shutdown abandons finalization; none starts afterwards. */
  private readonly finalizeAbort = new AbortController();

  private readonly queue: Array<QueueItem> = [];
  private unfinishedTasks = 0;
  private sentinelCount = 0;
  private joinWaiters: Array<() => void> = [];
  private itemWaiter:
    | ((next: QueueItem | typeof TIMED_OUT | typeof WORKER_CANCELLED) => void)
    | null = null;
  private shuttingDown = false;
  private appenderClosed = false;
  private connectionIdleSince: number | null = null;
  private worker: Promise<void> | null = null;
  private workerSettled = false;
  private workerCancelled = false;
  private readonly workerAbort = new AbortController();
  private readonly dropped = new Map<DropReason, number>(
    DROP_REASONS.map((reason) => [reason, 0]),
  );

  constructor(params: BatchProcessorParams) {
    this.appender =
      params.appender ??
      createStorageRowAppender({
        client: params.writeClient,
        schema: params.schema,
        ownsClient: params.ownsWriteClient,
      });
    this.schema = params.schema;
    this.writeStream =
      params.writeStream ?? defaultStreamName(params.destinationTable);
    this.batchSize = params.batchSize;
    this.flushInterval = params.flushInterval;
    this.retryConfig = params.retryConfig;
    this.queueMaxSize = params.queueMaxSize;
    this.shutdownTimeout = params.shutdownTimeout;
    this.exactlyOnceDelivery = params.exactlyOnceDelivery;
    this.createStream = params.createStream;
  }

  private recordDrop(reason: DropReason, count = 1): number {
    const total = (this.dropped.get(reason) ?? 0) + count;
    this.dropped.set(reason, total);
    return total;
  }

  /**
   * Resolves once every queued row has been written or dropped, including
   * batches in flight.
   */
  flush(): Promise<void> {
    if (this.unfinishedTasks === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.joinWaiters.push(resolve);
    });
  }

  start(): void {
    if (this.worker !== null) {
      return;
    }
    this.worker = this.batchWriter().finally(() => {
      this.workerSettled = true;
    });
  }

  /**
   * Enqueues a row; never throws. Overflow and post-shutdown rows are counted
   * as drops. The last few slots are kept for `INVOCATION_COMPLETED` and
   * `INVOCATION_ERROR` rows.
   */
  append(row: EventRow): void {
    if (this.shuttingDown) {
      this.recordDrop('shutdown_cancelled');
      logger.warn(
        'BigQuery batch processor is already shut down, dropping event.',
      );
      return;
    }
    const reserved = TERMINAL_EVENT_TYPES.has(String(row.event_type))
      ? 0
      : this.reservedTerminalSlots();
    if (!this.put(row, reserved)) {
      const total = this.recordDrop('queue_full');
      logger.warn(
        `BigQuery log queue full, dropping event. Total events dropped (queue full): ${total}`,
      );
    }
  }

  /**
   * Dropped-row counts keyed by reason, the canonical signal that data was
   * lost. `arrow_prep_failed` keeps adk-python's name and means the batch could
   * not be encoded for the table schema.
   */
  getDropStats(): DropStats {
    return Object.fromEntries(this.dropped);
  }

  get droppedEventCount(): number {
    return [...this.dropped.values()].reduce(
      (total, count) => total + count,
      0,
    );
  }

  private reservedTerminalSlots(): number {
    return Math.max(
      0,
      Math.min(
        Math.max(2, Math.floor(this.queueMaxSize / 100)),
        this.queueMaxSize - 1,
      ),
    );
  }

  private put(item: QueueItem, reserved = 0): boolean {
    if (this.queue.length >= this.queueMaxSize - reserved) {
      return false;
    }
    this.queue.push(item);
    this.unfinishedTasks += 1;
    this.itemWaiter?.(this.queue.shift() ?? TIMED_OUT);
    return true;
  }

  private taskDone(): void {
    this.unfinishedTasks = Math.max(0, this.unfinishedTasks - 1);
    if (this.unfinishedTasks === 0) {
      const waiters = this.joinWaiters;
      this.joinWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  private nextItem(
    timeoutSeconds: number,
  ): Promise<QueueItem | typeof TIMED_OUT> {
    const item = this.queue.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    if (this.workerAbort.signal.aborted) {
      return Promise.reject(new WorkerCancelledError());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.itemWaiter = null;
        resolve(TIMED_OUT);
      }, timeoutSeconds * 1000);
      // An idle writer must not keep the process alive.
      timer.unref();
      this.itemWaiter = (next) => {
        clearTimeout(timer);
        this.itemWaiter = null;
        if (next === WORKER_CANCELLED) {
          reject(new WorkerCancelledError());
          return;
        }
        resolve(next);
      };
    });
  }

  private async batchWriter(): Promise<void> {
    while (!this.shuttingDown || this.queue.length > 0) {
      const batch: Array<EventRow> = [];
      try {
        const first = this.shuttingDown
          ? this.queue.shift()
          : await this.nextItem(this.flushInterval);
        if (first === undefined) {
          break;
        }
        if (first === TIMED_OUT) {
          this.closeIdleConnections();
          continue;
        }
        if (first === SHUTDOWN_SENTINEL) {
          this.sentinelCount = Math.max(0, this.sentinelCount - 1);
          this.taskDone();
          continue;
        }
        batch.push(first);
        while (batch.length < this.batchSize) {
          const item = this.queue.shift();
          if (item === undefined) {
            break;
          }
          if (item === SHUTDOWN_SENTINEL) {
            this.sentinelCount = Math.max(0, this.sentinelCount - 1);
            this.taskDone();
            continue;
          }
          batch.push(item);
        }
        try {
          await this.writeRowsWithRetry(batch);
        } finally {
          this.connectionIdleSince = monotonicSeconds();
          batch.forEach(() => this.taskDone());
        }
      } catch (error) {
        if (error instanceof WorkerCancelledError) {
          if (batch.length > 0) {
            this.recordDrop('shutdown_timeout', batch.length);
            logger.warn(
              `${batch.length} in-flight row(s) dropped by shutdown cancellation.`,
            );
          }
          logger.info('Batch writer task cancelled.');
          return;
        }
        logger.error(`Error in batch writer loop: ${errorText(error)}`);
        if (this.shuttingDown) {
          break;
        }
        try {
          await sleep(1, this.workerAbort.signal);
        } catch {
          break;
        }
      }
    }
  }

  /**
   * Closes stream connections left open by a writer that has been idle for
   * `IDLE_CONNECTION_SECONDS`; the next append reopens one.
   */
  private closeIdleConnections(): void {
    if (
      this.connectionIdleSince !== null &&
      monotonicSeconds() - this.connectionIdleSince >= IDLE_CONNECTION_SECONDS
    ) {
      this.connectionIdleSince = null;
      this.appender.close();
    }
  }

  /**
   * Finalizes the streams awaiting finalization and, with `includeCurrent`,
   * the active committed stream. Runs are serialized and each finalization is
   * bounded, so a hung call cannot block later ones; once `finalizeAbort`
   * aborts, the remaining streams stay pending.
   */
  private async finalizeStream({
    includeCurrent = true,
  }: {includeCurrent?: boolean} = {}): Promise<void> {
    if (!this.exactlyOnceDelivery) {
      return;
    }
    const {signal} = this.finalizeAbort;
    const previous = this.finalizeChain;
    const run = (async (): Promise<void> => {
      await previous;
      const streams = new Set(this.pendingFinalizeStreams);
      if (includeCurrent && !this.streamFinalized) {
        streams.add(this.writeStream);
      }
      for (const name of streams) {
        if (signal.aborted) {
          this.pendingFinalizeStreams.add(name);
          continue;
        }
        const finalized = this.appender.finalizeWriteStream({name});
        if (
          !(await settlesWithin(finalized, FINALIZE_TIMEOUT_SECONDS, signal))
        ) {
          this.pendingFinalizeStreams.add(name);
          logger.warn(
            `Timed out finalizing BigQuery committed stream ${name}.`,
          );
          continue;
        }
        try {
          await finalized;
        } catch (error) {
          this.pendingFinalizeStreams.add(name);
          logger.warn(
            `Could not finalize BigQuery committed stream ${name}: ${errorText(error)}`,
          );
          continue;
        }
        this.pendingFinalizeStreams.delete(name);
        if (name === this.writeStream) {
          this.streamFinalized = true;
        }
      }
    })();
    this.finalizeChain = run.catch(() => undefined);
    await run;
  }

  private desyncStream(): void {
    this.offsetDesynced = true;
  }

  private confirmCommittedDelivery(
    offset: number | null,
    rowCount: number,
  ): void {
    if (offset === null) {
      logger.error(
        'Committed-stream delivery was confirmed without a batch offset; rotating the stream before the next batch.',
      );
      this.desyncStream();
      return;
    }
    this.nextOffset = offset + rowCount;
  }

  private handleAlreadyExists({
    offset,
    rowCount,
    hadAmbiguousSend,
  }: {
    offset: number | null;
    rowCount: number;
    hadAmbiguousSend: boolean;
  }): void {
    if (hadAmbiguousSend) {
      this.confirmCommittedDelivery(offset, rowCount);
      return;
    }
    logger.warn(
      `BigQuery committed stream reported an occupied offset ${String(offset)} before this batch had an ambiguous append; rotating the stream.`,
    );
    this.desyncStream();
    this.recordDrop('offset_conflict', rowCount);
  }

  private async ensureWritableStream(rowCount: number): Promise<boolean> {
    if (!this.exactlyOnceDelivery || !this.offsetDesynced) {
      return true;
    }
    const now = monotonicSeconds();
    if (this.createStream === undefined || now < this.rotationRetryAt) {
      this.recordDrop('offset_conflict', rowCount);
      return false;
    }
    const oldStream = this.writeStream;
    this.pendingFinalizeStreams.add(oldStream);
    const created = this.createStream();
    let newStream: string;
    try {
      newStream = await withDeadline({
        promise: created,
        seconds: APPEND_TIMEOUT_SECONDS,
        signal: this.workerAbort.signal,
      });
    } catch (error) {
      // A replacement that arrives after giving up is never written to.
      created.then(
        (name) => this.abandonStream(name),
        () => undefined,
      );
      if (error instanceof WorkerCancelledError) {
        throw error;
      }
      this.rotationRetryAt = now + ROTATION_BACKOFF_SECONDS;
      this.recordDrop('offset_conflict', rowCount);
      logger.error(
        `Could not replace desynchronized BigQuery stream ${oldStream}; dropping ${rowCount} row(s): ${errorText(error)}`,
      );
      return false;
    }
    this.writeStream = newStream;
    this.nextOffset = 0;
    this.offsetDesynced = false;
    this.rotationRetryAt = 0;
    this.streamFinalized = false;
    // Nothing writes to the old stream again; finalize it and release its
    // connection in the background instead of stalling the single writer.
    this.finalizeStream({includeCurrent: false}).catch(() => undefined);
    return true;
  }

  private abandonStream(name: string): void {
    this.appender.finalizeWriteStream({name}).catch((error: unknown) => {
      logger.warn(
        `Could not finalize abandoned BigQuery committed stream ${name}: ${errorText(error)}`,
      );
    });
  }

  private encodeBatch(rows: ReadonlyArray<EventRow>): Array<EncodedRow> {
    return rows.map((row) => encodeRecord(this.schema, row));
  }

  /**
   * Handles one in-band AppendRows response. Returns normally when the batch is
   * settled (written or counted as dropped), returns the indices of rejected
   * rows when the rest of the batch should be resent, and throws
   * `RetryableWriteResponseError` / `AppendTimeoutError` to retry.
   */
  private settleResponse({
    response,
    rowCount,
    offset,
    hadAmbiguousSend,
    canResend,
  }: {
    response: AppendRowsOutcome;
    rowCount: number;
    offset: number | null;
    hadAmbiguousSend: boolean;
    canResend: boolean;
  }): ReadonlySet<number> | undefined {
    if (response === null) {
      // Every row carries an event_id, so a resend that duplicates a row on
      // the default stream can be deduplicated; silently losing it cannot.
      throw new AppendTimeoutError('BigQuery returned no append response');
    }
    const code = response.error?.code ?? 0;
    if (code === 0) {
      if (this.exactlyOnceDelivery) {
        this.confirmCommittedDelivery(offset, rowCount);
      }
      return undefined;
    }
    const message = response.error?.message ?? 'Unknown error';
    logger.warn(`BigQuery Write API returned error code ${code}: ${message}`);
    if (this.exactlyOnceDelivery) {
      if (code === GRPC_CODE.ALREADY_EXISTS) {
        this.handleAlreadyExists({offset, rowCount, hadAmbiguousSend});
        return undefined;
      }
      if (code === GRPC_CODE.NOT_FOUND || code === GRPC_CODE.OUT_OF_RANGE) {
        this.desyncStream();
        this.recordDrop('offset_conflict', rowCount);
        return undefined;
      }
    }
    if (code === GRPC_CODE.PERMISSION_DENIED) {
      logger.error(
        `BigQuery Write API permission denied: ${message}. ${rowCount} row(s) dropped.`,
      );
      if (this.exactlyOnceDelivery && hadAmbiguousSend) {
        this.desyncStream();
      }
      this.recordDrop('permission_denied', rowCount);
      return undefined;
    }
    // In exactly-once mode NOT_FOUND was already an offset conflict above.
    if (code === GRPC_CODE.NOT_FOUND) {
      logger.error(
        `BigQuery Write API stream or table not found: ${message}. ${rowCount} row(s) dropped.`,
      );
      this.recordDrop('not_found', rowCount);
      return undefined;
    }
    if (RETRYABLE_IN_BAND_CODES.has(code)) {
      throw new RetryableWriteResponseError(message);
    }
    const rejected = canResend
      ? rejectedRowIndices(response.rowErrors, rowCount)
      : undefined;
    if (isSchemaMismatch(message)) {
      logger.error(
        `BigQuery Schema Mismatch: ${message}. This usually means the table schema does not match the expected schema.`,
      );
    } else {
      logger.error(`Non-retryable BigQuery error: ${message}`);
      for (const rowError of response.rowErrors ?? []) {
        logger.error(`Row error details: ${stringifyOrString(rowError)}`);
      }
      logger.error(
        `${rejected?.size ?? rowCount} row(s) dropped due to a non-retryable BigQuery error.`,
      );
    }
    // In-band row rejections leave the stream usable; only an earlier ambiguous
    // send poisons it.
    if (this.exactlyOnceDelivery && hadAmbiguousSend) {
      this.desyncStream();
    }
    this.recordDrop('non_retryable', rejected?.size ?? rowCount);
    return rejected;
  }

  /** One AppendRows attempt, abandoned for good on timeout or shutdown. */
  private async appendOnce(
    rows: Array<EncodedRow>,
    offset: number | null,
  ): Promise<AppendRowsOutcome> {
    const attempt = new AbortController();
    try {
      return await withDeadline({
        promise: this.appender.appendRows({
          writeStream: this.writeStream,
          rows,
          offset,
          traceId: WRITER_TRACE_ID,
          signal: attempt.signal,
        }),
        seconds: APPEND_TIMEOUT_SECONDS,
        signal: this.workerAbort.signal,
      });
    } catch (error) {
      // An abandoned attempt must not send later and duplicate its retry or
      // write after shutdown counted the batch as dropped.
      attempt.abort();
      throw error;
    }
  }

  private async writeRowsWithRetry(
    rows: ReadonlyArray<EventRow>,
  ): Promise<void> {
    if (!(await this.ensureWritableStream(rows.length))) {
      return;
    }
    let attempt = 0;
    let delay = this.retryConfig.initialDelay;
    const offset = this.exactlyOnceDelivery ? this.nextOffset : null;
    let hadAmbiguousSend = false;
    let resent = false;

    let encoded: Array<EncodedRow>;
    try {
      encoded = this.encodeBatch(rows);
    } catch (error) {
      this.dropUnencodable(rows.length, errorText(error));
      return;
    }

    while (attempt <= this.retryConfig.maxRetries) {
      const rowCount = encoded.length;
      let requestSent = false;
      let definitiveRejection = false;
      try {
        requestSent = true;
        const response = await this.appendOnce(encoded, offset);
        definitiveRejection =
          response !== null && (response.error?.code ?? 0) !== 0;
        const rejected = this.settleResponse({
          response,
          rowCount,
          offset,
          hadAmbiguousSend,
          canResend: !resent,
        });
        if (rejected === undefined) {
          return;
        }
        // BigQuery rejects the whole request when any row fails; the rows it
        // did not name are resent once.
        resent = true;
        encoded = encoded.filter((_row, index) => !rejected.has(index));
        logger.warn(
          `Resending ${encoded.length} row(s) rejected only alongside invalid rows.`,
        );
        continue;
      } catch (error) {
        if (error instanceof WorkerCancelledError) {
          throw error;
        }
        if (error instanceof RowEncodingError) {
          this.dropUnencodable(rowCount, errorText(error));
          return;
        }
        const code = grpcCode(error);
        const retryable =
          error instanceof RetryableWriteResponseError ||
          error instanceof AppendTimeoutError ||
          error instanceof AppendAbortedError ||
          (code !== null && RETRYABLE_RAISED_CODES.has(code));

        if (code === GRPC_CODE.ALREADY_EXISTS) {
          if (this.exactlyOnceDelivery) {
            this.handleAlreadyExists({offset, rowCount, hadAmbiguousSend});
            return;
          }
          this.recordDrop('unexpected_error', rowCount);
          logger.error(
            `Unexpected BigQuery Write API error: ${errorText(error)}`,
          );
          return;
        }
        if (code === GRPC_CODE.PERMISSION_DENIED) {
          if (this.exactlyOnceDelivery && hadAmbiguousSend) {
            this.desyncStream();
          }
          this.recordDrop('permission_denied', rowCount);
          logger.error(
            `BigQuery Write API permission denied (Dropping batch): ${errorText(error)}`,
          );
          return;
        }
        if (code === GRPC_CODE.NOT_FOUND || code === GRPC_CODE.OUT_OF_RANGE) {
          if (this.exactlyOnceDelivery) {
            this.desyncStream();
            this.recordDrop('offset_conflict', rowCount);
            logger.warn(
              `BigQuery committed stream rejected offset ${String(offset)}: ${errorText(error)}`,
            );
            return;
          }
          if (code === GRPC_CODE.NOT_FOUND) {
            this.recordDrop('not_found', rowCount);
            logger.error(
              `BigQuery Write API stream or table not found (Dropping batch): ${errorText(error)}`,
            );
            return;
          }
          this.recordDrop('unexpected_error', rowCount);
          logger.error(
            `Unexpected BigQuery Write API error: ${errorText(error)}`,
          );
          return;
        }
        if (retryable) {
          if (requestSent && !definitiveRejection) {
            hadAmbiguousSend = true;
          }
          attempt += 1;
          if (attempt > this.retryConfig.maxRetries) {
            const total = this.recordDrop('retry_exhausted', rowCount);
            if (this.exactlyOnceDelivery && hadAmbiguousSend) {
              this.desyncStream();
            }
            logger.error(
              `BigQuery Batch Dropped after ${this.retryConfig.maxRetries + 1} attempts. Last error: ${errorText(error)}. Total rows dropped (retry exhausted): ${total}`,
            );
            return;
          }
          const sleepTime = Math.min(
            delay * (1 + Math.random()),
            this.retryConfig.maxDelay,
          );
          logger.warn(
            `BigQuery write failed (Attempt ${attempt}), retrying in ${sleepTime.toFixed(2)}s... Error: ${errorText(error)}`,
          );
          await sleep(sleepTime, this.workerAbort.signal);
          delay *= this.retryConfig.multiplier;
          continue;
        }
        if (code !== null && NON_RETRYABLE_RAISED_CODES.has(code)) {
          // Rejected outright: nothing was written and a retry cannot succeed.
          const message = errorText(error);
          const schemaMismatch = isSchemaMismatch(message);
          if (schemaMismatch) {
            logger.error(
              `BigQuery Schema Mismatch: ${message}. This usually means the table schema does not match the expected schema.`,
            );
          } else {
            logger.error(`Non-retryable BigQuery error: ${message}`);
            logger.error(
              `${rowCount} row(s) dropped due to a non-retryable BigQuery error.`,
            );
          }
          // Unauthenticated and schema mismatches leave a committed stream
          // usable; other InvalidArgument / FailedPrecondition can mean a
          // finalized, expired or in-use stream.
          const streamStateRejection =
            (code === GRPC_CODE.INVALID_ARGUMENT ||
              code === GRPC_CODE.FAILED_PRECONDITION) &&
            !schemaMismatch;
          if (
            this.exactlyOnceDelivery &&
            (hadAmbiguousSend || streamStateRejection)
          ) {
            this.desyncStream();
          }
          this.recordDrop('non_retryable', rowCount);
          return;
        }
        const totalDropped = this.recordDrop('unexpected_error', rowCount);
        if (requestSent && !definitiveRejection) {
          hadAmbiguousSend = true;
        }
        if (this.exactlyOnceDelivery && hadAmbiguousSend) {
          this.desyncStream();
        }
        logger.error(
          `Unexpected BigQuery Write API error (Dropping batch): ${errorText(error)}. Total rows dropped (unexpected error): ${totalDropped}`,
        );
        return;
      }
    }
  }

  private dropUnencodable(rowCount: number, reason: string): void {
    const total = this.recordDrop('arrow_prep_failed', rowCount);
    logger.error(
      `Failed to prepare BigQuery batch (Data Loss): ${reason}. Total rows dropped (arrow prep failed): ${total}`,
    );
  }

  private drainQueueAndCount(reason: DropReason): number {
    let drained = 0;
    for (
      let item = this.queue.shift();
      item !== undefined;
      item = this.queue.shift()
    ) {
      if (item === SHUTDOWN_SENTINEL) {
        this.sentinelCount = Math.max(0, this.sentinelCount - 1);
      } else {
        drained += 1;
      }
      this.taskDone();
    }
    if (drained > 0) {
      this.recordDrop(reason, drained);
      logger.warn(`${drained} queued row(s) dropped (${reason}).`);
    }
    return drained;
  }

  /**
   * Aborts the worker and waits for it until `deadline`; it counts its own
   * in-flight batch as it exits.
   */
  private async cancelWorker(deadline: number): Promise<void> {
    this.workerCancelled = true;
    this.workerAbort.abort();
    this.itemWaiter?.(WORKER_CANCELLED);
    if (
      this.worker !== null &&
      !(await settlesWithin(this.worker, deadline - monotonicSeconds()))
    ) {
      logger.warn('BigQuery batch writer did not stop within the budget.');
    }
  }

  /**
   * Drains queued rows within `timeoutSeconds` (default `shutdownTimeout`),
   * finalizes an exactly-once committed stream within the same budget, then
   * closes the appender's stream connections.
   */
  async shutdown({
    timeoutSeconds = this.shutdownTimeout,
  }: {timeoutSeconds?: number} = {}): Promise<void> {
    const deadline = monotonicSeconds() + Math.max(0, timeoutSeconds);
    try {
      await this.shutdownWorker(deadline);
    } finally {
      await this.finalizeStreamBefore(deadline);
      this.closeAppender();
    }
  }

  private closeAppender(): void {
    if (this.appenderClosed) {
      return;
    }
    this.appenderClosed = true;
    try {
      this.appender.close();
    } catch (error) {
      logger.warn(
        `Could not close BigQuery stream connections: ${errorText(error)}`,
      );
    }
  }

  /**
   * Finalizes within `deadline`. When it passes, abandons the finalization
   * chain; no finalization starts after that.
   */
  private async finalizeStreamBefore(deadline: number): Promise<void> {
    if (!this.exactlyOnceDelivery) {
      return;
    }
    if (this.streamFinalized && this.pendingFinalizeStreams.size === 0) {
      return;
    }
    const remaining = deadline - monotonicSeconds();
    if (remaining <= 0) {
      this.finalizeAbort.abort();
      logger.warn(
        `No shutdown budget remained to finalize BigQuery committed stream ${this.writeStream}.`,
      );
      return;
    }
    if (!(await settlesWithin(this.finalizeStream(), remaining))) {
      this.finalizeAbort.abort();
      logger.warn(
        `Timed out finalizing BigQuery committed stream ${this.writeStream}.`,
      );
    }
  }

  private async shutdownWorker(deadline: number): Promise<void> {
    this.shuttingDown = true;
    logger.info('BatchProcessor shutting down, draining queue...');
    if (this.put(SHUTDOWN_SENTINEL)) {
      this.sentinelCount += 1;
    }
    if (this.worker === null) {
      return;
    }
    if (this.workerSettled) {
      // A terminal worker cannot drain anything; account for what is still
      // queued.
      this.drainQueueAndCount(
        this.workerCancelled ? 'shutdown_cancelled' : 'shutdown_timeout',
      );
      return;
    }
    if (await settlesWithin(this.worker, deadline - monotonicSeconds())) {
      return;
    }
    logger.warn('BatchProcessor shutdown timed out, cancelling worker.');
    await this.cancelWorker(deadline);
    // The cancelled worker counts its own in-flight batch.
    this.drainQueueAndCount('shutdown_timeout');
  }

  /**
   * Waits up to `shutdownTimeout` for queued rows, finalizes an exactly-once
   * committed stream, then closes the appender's stream connections. After
   * `shutdown()` it only makes sure the connections are closed.
   */
  async close(): Promise<void> {
    if (this.shuttingDown) {
      this.closeAppender();
      return;
    }
    const deadline = monotonicSeconds() + Math.max(0, this.shutdownTimeout);
    try {
      await this.closeWorker(deadline);
    } finally {
      await this.finalizeStreamBefore(deadline);
      this.closeAppender();
    }
  }

  private async closeWorker(deadline: number): Promise<void> {
    this.shuttingDown = true;
    if (!(await settlesWithin(this.flush(), this.shutdownTimeout))) {
      logger.warn(
        'Timeout waiting for BigQuery batch queue to empty on shutdown.',
      );
    }
    if (this.worker !== null && !this.workerSettled) {
      await this.cancelWorker(deadline);
    }
    let drained = 0;
    for (
      let item = this.queue.shift();
      item !== undefined;
      item = this.queue.shift()
    ) {
      if (item !== SHUTDOWN_SENTINEL) {
        drained += 1;
      }
      this.taskDone();
    }
    if (drained > 0) {
      this.recordDrop('shutdown_timeout', drained);
      logger.warn(`${drained} queued row(s) dropped by close timeout.`);
    }
  }
}
