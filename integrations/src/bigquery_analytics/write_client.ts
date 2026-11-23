/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type TableField} from '@google-cloud/bigquery';
import type {managedwriter} from '@google-cloud/bigquery-storage';
import {logger, version} from '@google/adk';

/** gRPC status codes the batch writer classifies (google.rpc.Code). */
export const GRPC_CODE = {
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

export const WRITER_TRACE_ID = `google-adk-bq-logger/${version}`;

type StorageWriteModule = typeof import('@google-cloud/bigquery-storage');

let storageWriteModule: Promise<StorageWriteModule> | undefined;

/**
 * `@google-cloud/bigquery-storage` is an optional peer dependency, loaded on
 * first use so that importing the package does not load gRPC.
 */
function loadStorageWrite(): Promise<StorageWriteModule> {
  storageWriteModule ??= import('@google-cloud/bigquery-storage').catch(
    (error: unknown) => {
      storageWriteModule = undefined;
      throw error;
    },
  );
  return storageWriteModule;
}

/**
 * A column value after JSON-column serialization, ready for the protobuf
 * encoder.
 */
export type EncodedValue =
  string | number | boolean | Date | null | Array<EncodedValue> | EncodedRow;

export interface EncodedRow {
  [column: string]: EncodedValue;
}

interface AppendRowsError {
  code?: number | null;
  message?: string | null;
}

/**
 * The in-band outcome of one AppendRows call; `null` means the stream ended
 * without a response.
 */
export type AppendRowsOutcome = {
  error?: AppendRowsError | null;
  rowErrors?: ReadonlyArray<object> | null;
} | null;

/**
 * The transport seam of the batch writer: one AppendRows request per call.
 * Rejections carry the gRPC status in a numeric `code` property, as
 * `google-gax` errors do.
 */
export interface RowAppender {
  /**
   * Sends one request. Once `signal` aborts, nothing more is sent and the call
   * rejects with `AppendAbortedError`.
   */
  appendRows: (params: {
    writeStream: string;
    rows: Array<EncodedRow>;
    offset: number | null;
    traceId: string;
    signal?: AbortSignal;
  }) => Promise<AppendRowsOutcome>;
  /** Closes the stream's connection, then finalizes the stream. */
  finalizeWriteStream: (params: {name: string}) => Promise<void>;
  /** Closes every open stream connection; a later append reopens it. */
  close: () => void;
}

type StreamConnection = Awaited<
  ReturnType<managedwriter.WriterClient['createStreamConnection']>
>;

interface PooledConnection {
  connection: StreamConnection;
  /** The client generation whose connection list holds `connection`. */
  generation: number;
}

interface StreamWriter extends PooledConnection {
  writer: managedwriter.JSONWriter;
  /** Unregisters the appender's own schema listener on `connection`. */
  stopSchemaUpdates: () => void;
}

/**
 * Closed connections the SDK client still lists but that are never reused
 * (left with pending requests, finalized, or past the standby bound); a
 * plugin-owned client is recycled once this many accumulate.
 */
export const MAX_RETIRED_CONNECTIONS = 8;

/** Closed, idle connections kept per stream for reuse. */
export const MAX_STANDBY_CONNECTIONS = 2;

/**
 * In-band AppendRows codes that `StreamConnection` rejects the pending write
 * with, rather than resolving it, when write retries are disabled.
 */
const SDK_RAISED_IN_BAND_CODES: ReadonlySet<number> = new Set([
  GRPC_CODE.CANCELLED,
  GRPC_CODE.DEADLINE_EXCEEDED,
  GRPC_CODE.ABORTED,
  GRPC_CODE.INTERNAL,
  GRPC_CODE.UNAVAILABLE,
]);

/**
 * `StreamConnection`'s rejection of the requests still pending when its
 * connection closed.
 */
const CONNECTION_CLOSED_MESSAGE =
  'Connection failure, please retry the request';

/** The append was abandoned by its caller; whether it was sent is unknown. */
export class AppendAbortedError extends Error {
  override readonly name = 'AppendAbortedError';

  constructor() {
    super('BigQuery append was aborted');
  }
}

/** The rows could not be encoded for the table schema; nothing was sent. */
export class RowEncodingError extends Error {
  override readonly name = 'RowEncodingError';

  constructor(cause: Error) {
    super(cause.message, {cause});
  }
}

function destinationTablePath({
  projectId,
  datasetId,
  tableId,
}: {
  projectId: string;
  datasetId: string;
  tableId: string;
}): string {
  return `projects/${projectId}/datasets/${datasetId}/tables/${tableId}`;
}

export function defaultStreamName(destinationTable: string): string {
  return `${destinationTable}/streams/_default`;
}

export async function createWriteClient({
  projectId,
}: {
  projectId: string;
}): Promise<managedwriter.WriterClient> {
  const {managedwriter} = await loadStorageWrite();
  return new managedwriter.WriterClient({
    projectId,
    libName: 'google-adk-bq-logger',
    libVersion: version,
  });
}

/** Creates one committed stream for offset-aware appends. */
export async function createCommittedWriteStream({
  client,
  projectId,
  datasetId,
  tableId,
}: {
  client: managedwriter.WriterClient;
  projectId: string;
  datasetId: string;
  tableId: string;
}): Promise<string> {
  const {managedwriter} = await loadStorageWrite();
  return client.createWriteStream({
    streamType: managedwriter.CommittedStream,
    destinationTable: destinationTablePath({projectId, datasetId, tableId}),
  });
}

/**
 * Closes a write client's connections and transport, waiting at most
 * `timeoutSeconds`. A timeout is logged; a failed close rejects.
 */
export async function closeWriteClient({
  client,
  timeoutSeconds = 10,
}: {
  client: managedwriter.WriterClient;
  timeoutSeconds?: number;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client.close();
    const closed = await Promise.race([
      client
        .getClient()
        .close()
        .then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutSeconds * 1000);
      }),
    ]);
    if (!closed) {
      logger.warn('Timed out closing the BigQuery write transport.');
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Storage Write API appender: one `JSONWriter` per stream, encoding rows
 * with a proto2 descriptor derived from the table schema. Library-level write
 * retries stay disabled so the batch processor's retry and offset bookkeeping
 * is the only retry policy.
 *
 * The SDK client lists every connection it opens until the client closes. A
 * closed connection with no pending request is kept for reuse; one left with
 * a pending request is retired, since reopening it would pair that request
 * with the next response. With `ownsClient`, retired connections are released
 * by closing the client's connections once `MAX_RETIRED_CONNECTIONS` build up
 * and no stream has an open writer; a supplied client keeps them until its
 * owner closes it.
 */
export function createStorageRowAppender({
  client,
  schema,
  ownsClient = false,
}: {
  client: managedwriter.WriterClient;
  schema: Array<TableField>;
  ownsClient?: boolean;
}): RowAppender {
  client.enableWriteRetries(false);
  type ProtoDescriptor = ReturnType<
    StorageWriteModule['adapt']['convertStorageSchemaToProto2Descriptor']
  >;
  type StorageTableSchema = Parameters<
    StorageWriteModule['adapt']['convertStorageSchemaToProto2Descriptor']
  >[0];
  let writerModule:
    | Promise<{
        JSONWriter: typeof managedwriter.JSONWriter;
        toDescriptor: (schema: StorageTableSchema) => ProtoDescriptor;
        protoDescriptor: ProtoDescriptor;
      }>
    | undefined;
  const loadWriter = () =>
    (writerModule ??= loadStorageWrite().then(({adapt, managedwriter}) => ({
      JSONWriter: managedwriter.JSONWriter,
      toDescriptor: (schema: StorageTableSchema) =>
        adapt.convertStorageSchemaToProto2Descriptor(schema, 'root'),
      protoDescriptor: adapt.convertStorageSchemaToProto2Descriptor(
        adapt.convertBigQuerySchemaToStorageTableSchema({fields: schema}),
        'root',
      ),
    })));
  /**
   * The table schema of BigQuery's latest `updatedSchema` response, including
   * one carried by a rejected append.
   */
  let updatedSchema: StorageTableSchema | undefined;
  const writers = new Map<string, Promise<StreamWriter>>();
  /** Writers whose promise has resolved, so eviction can close them at once. */
  const opened = new WeakMap<Promise<StreamWriter>, StreamWriter>();
  const standby = new Map<string, Array<PooledConnection>>();
  /**
   * Counts stream finalizations. An evicted writer that is still being
   * acquired is reused only if no stream was finalized before it arrived.
   */
  let finalizations = 0;
  let generation = 0;
  let retired = 0;
  const transportErrors = new WeakSet<object>();

  /**
   * A fresh `JSONWriter`, and so a fresh schema listener, on every open: a
   * closed `JSONWriter` no longer follows schema updates.
   */
  async function openWriter(pooled: PooledConnection): Promise<StreamWriter> {
    const {JSONWriter, toDescriptor, protoDescriptor} = await loadWriter();
    const writer = new JSONWriter({
      connection: pooled.connection,
      protoDescriptor:
        updatedSchema === undefined
          ? protoDescriptor
          : toDescriptor(updatedSchema),
      traceId: WRITER_TRACE_ID,
    });
    // The SDK emits the update before it rejects an append whose response
    // also carries an error, so the pending write's result can miss it.
    const listener = pooled.connection.onSchemaUpdated((schema) => {
      updatedSchema = schema;
    });
    return {...pooled, writer, stopSchemaUpdates: () => listener.off()};
  }

  async function connect(writeStream: string): Promise<PooledConnection> {
    const connection = await client.createStreamConnection({
      streamId: writeStream,
    });
    // Without a listener EventEmitter re-throws a connection error; the
    // pending write already carries it to the batch processor.
    connection.onConnectionError((error) => {
      transportErrors.add(error);
    });
    // The SDK lists the connection in the client's current connection list,
    // even when the client was recycled while the acquisition was pending.
    return {connection, generation};
  }

  function takeStandby(writeStream: string): PooledConnection | undefined {
    const pool = standby.get(writeStream);
    const pooled = pool?.pop();
    if (pool?.length === 0) {
      standby.delete(writeStream);
    }
    return pooled;
  }

  /** Keeps a closed connection for reuse, or counts it as retired. */
  function release(
    writeStream: string,
    pooled: PooledConnection,
    reuse: boolean,
  ): void {
    if (pooled.generation !== generation) {
      return;
    }
    const pool = standby.get(writeStream) ?? [];
    if (
      reuse &&
      pooled.connection.getPendingWrites().length === 0 &&
      pool.length < MAX_STANDBY_CONNECTIONS
    ) {
      pool.push({connection: pooled.connection, generation});
      standby.set(writeStream, pool);
      return;
    }
    retired += 1;
  }

  function retireStandby(writeStream: string): void {
    retired += standby.get(writeStream)?.length ?? 0;
    standby.delete(writeStream);
  }

  /**
   * Closes every connection of a plugin-owned client, which empties its
   * connection list, once enough retired ones build up and none is in use.
   */
  function recycleClientIfDue(): void {
    if (!ownsClient || retired < MAX_RETIRED_CONNECTIONS || writers.size > 0) {
      return;
    }
    client.close();
    generation += 1;
    retired = 0;
    standby.clear();
  }

  function writerFor(writeStream: string): Promise<StreamWriter> {
    const existing = writers.get(writeStream);
    if (existing) {
      return existing;
    }
    recycleClientIfDue();
    const pooled = takeStandby(writeStream);
    const created = (
      pooled === undefined ? connect(writeStream) : Promise.resolve(pooled)
    ).then(openWriter);
    created.then(
      (writer) => opened.set(created, writer),
      () => evict(writeStream, {writer: created}),
    );
    writers.set(writeStream, created);
    return created;
  }

  /**
   * Closes and forgets the stream's writer, unless it was already replaced by
   * a newer one. A writer that arrives after its eviction is closed too. With
   * `reuse`, a closed connection without pending requests can reopen on a
   * later append.
   */
  function evict(
    writeStream: string,
    {
      writer,
      reuse = true,
    }: {writer?: Promise<StreamWriter>; reuse?: boolean} = {},
  ): void {
    const cached = writers.get(writeStream);
    if (!reuse) {
      retireStandby(writeStream);
      finalizations += 1;
    }
    if (cached === undefined || (writer !== undefined && cached !== writer)) {
      return;
    }
    writers.delete(writeStream);
    const close = (closed: StreamWriter, reuseClosed: boolean) => {
      closed.writer.close();
      closed.stopSchemaUpdates();
      release(writeStream, closed, reuseClosed);
    };
    const ready = opened.get(cached);
    if (ready !== undefined) {
      close(ready, reuse);
      return;
    }
    const evictedAt = finalizations;
    cached.then(
      (closed) => close(closed, reuse && evictedAt === finalizations),
      () => undefined,
    );
  }

  /**
   * The in-band AppendRows error behind an SDK rejection, or null when the
   * rejection came from the transport and the outcome is unknown.
   */
  function inBandError(error: unknown): AppendRowsError | null {
    if (
      !(error instanceof Error) ||
      transportErrors.has(error) ||
      error.message === CONNECTION_CLOSED_MESSAGE
    ) {
      return null;
    }
    const code: unknown = (error as {code?: unknown}).code;
    if (typeof code !== 'number' || !SDK_RAISED_IN_BAND_CODES.has(code)) {
      return null;
    }
    return {code, message: error.message};
  }

  function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new AppendAbortedError();
    }
  }

  /** Settles with `promise`, or rejects once `signal` aborts. */
  function unlessAborted<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (signal === undefined) {
      return promise;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AppendAbortedError());
      signal.addEventListener('abort', onAbort, {once: true});
    });
    return Promise.race([promise, aborted]).finally(() => {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    });
  }

  return {
    appendRows: async ({writeStream, rows, offset, signal}) => {
      throwIfAborted(signal);
      const cached = writerFor(writeStream);
      try {
        const {writer} = await unlessAborted(cached, signal);
        throwIfAborted(signal);
        let pending: ReturnType<managedwriter.JSONWriter['appendRows']>;
        try {
          // JSONWriter encodes synchronously, before anything is sent.
          pending = writer.appendRows(rows, offset ?? undefined);
        } catch (error) {
          throw new RowEncodingError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        const response = await unlessAborted(pending.getResult(), signal);
        return {
          error: response.error ?? null,
          rowErrors: response.rowErrors ?? null,
        };
      } catch (error) {
        if (error instanceof RowEncodingError) {
          throw error;
        }
        // An in-band rejection leaves the connection open and nothing pending.
        const inBand = inBandError(error);
        if (inBand !== null) {
          return {error: inBand, rowErrors: null};
        }
        // A stalled, abandoned or broken connection is closed; it reopens
        // only when no request is left pending on it.
        evict(writeStream, {writer: cached});
        // PendingWrite's rejection when the stream closed without acknowledging
        // the request.
        if (
          error instanceof Error &&
          error.message === 'ended with no status'
        ) {
          return null;
        }
        throw error;
      }
    },
    finalizeWriteStream: async ({name}) => {
      evict(name, {reuse: false});
      await client.finalizeWriteStream({name});
    },
    close: () => {
      for (const writeStream of [...writers.keys()]) {
        evict(writeStream);
      }
    },
  };
}
