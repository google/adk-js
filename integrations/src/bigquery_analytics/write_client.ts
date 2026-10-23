/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type TableField} from '@google-cloud/bigquery';
import {adapt, managedwriter} from '@google-cloud/bigquery-storage';
import {logger, version} from '@google/adk';

/** gRPC status codes the batch writer classifies (google.rpc.Code). */
export const GRPC_CODE = {
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  OUT_OF_RANGE: 11,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

export const WRITER_TRACE_ID = `google-adk-bq-logger/${version}`;

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
  appendRows: (params: {
    writeStream: string;
    rows: Array<EncodedRow>;
    offset: number | null;
    traceId: string;
  }) => Promise<AppendRowsOutcome>;
  finalizeWriteStream: (params: {name: string}) => Promise<void>;
  close: () => void;
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

export function createWriteClient({
  projectId,
}: {
  projectId: string;
}): managedwriter.WriterClient {
  return new managedwriter.WriterClient({
    projectId,
    libName: 'google-adk-bq-logger',
    libVersion: version,
  });
}

/** Creates one committed stream for offset-aware appends. */
export function createCommittedWriteStream({
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
  return client.createWriteStream({
    streamType: managedwriter.CommittedStream,
    destinationTable: destinationTablePath({projectId, datasetId, tableId}),
  });
}

/** Best-effort bounded close of a write client's connections and transport. */
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
    await Promise.race([
      client.getClient().close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutSeconds * 1000);
      }),
    ]);
  } catch {
    logger.warn('Could not close a detached BigQuery write transport.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Storage Write API appender: one `JSONWriter` per stream, encoding rows
 * with a proto2 descriptor derived from the table schema. Library-level write
 * retries stay disabled so the batch processor's retry and offset bookkeeping
 * is the only retry policy.
 */
export function createStorageRowAppender({
  client,
  schema,
}: {
  client: managedwriter.WriterClient;
  schema: Array<TableField>;
}): RowAppender {
  client.enableWriteRetries(false);
  const protoDescriptor = adapt.convertStorageSchemaToProto2Descriptor(
    adapt.convertBigQuerySchemaToStorageTableSchema({fields: schema}),
    'root',
  );
  const writers = new Map<string, Promise<managedwriter.JSONWriter>>();

  function writerFor(writeStream: string): Promise<managedwriter.JSONWriter> {
    const existing = writers.get(writeStream);
    if (existing) {
      return existing;
    }
    const created = client
      .createStreamConnection({streamId: writeStream})
      .then((connection) => {
        // Without a listener EventEmitter re-throws a connection error; the
        // pending write already carries it to the batch processor.
        connection.onConnectionError(() => undefined);
        return new managedwriter.JSONWriter({
          connection,
          protoDescriptor,
          traceId: WRITER_TRACE_ID,
        });
      });
    created.catch(() => writers.delete(writeStream));
    writers.set(writeStream, created);
    return created;
  }

  return {
    appendRows: async ({writeStream, rows, offset}) => {
      const writer = await writerFor(writeStream);
      let pending: ReturnType<managedwriter.JSONWriter['appendRows']>;
      try {
        // JSONWriter encodes synchronously, before anything is sent.
        pending = writer.appendRows(rows, offset ?? undefined);
      } catch (error) {
        throw new RowEncodingError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      try {
        const response = await pending.getResult();
        return {
          error: response.error ?? null,
          rowErrors: response.rowErrors ?? null,
        };
      } catch (error) {
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
      await client.finalizeWriteStream({name});
    },
    close: () => {
      for (const writer of writers.values()) {
        writer.then((w) => w.close()).catch(() => undefined);
      }
      writers.clear();
    },
  };
}
