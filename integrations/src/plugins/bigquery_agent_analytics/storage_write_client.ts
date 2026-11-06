/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQuery} from '@google-cloud/bigquery';
import type * as bqStorage from '@google-cloud/bigquery-storage';

import {version} from '../../version.js';
import type {AppendResult} from './batch_processor.js';
import {
  EVENTS_SCHEMA,
  type EventRow,
  SCHEMA_VERSION,
  SCHEMA_VERSION_LABEL_KEY,
} from './event_schema.js';

interface BigQuerySdks {
  readonly BigQuery: typeof BigQuery;
  readonly storage: typeof bqStorage;
}

let sdksPromise: Promise<BigQuerySdks> | null = null;

/**
 * Dynamically loads the optional `@google-cloud/bigquery` and `@google-cloud/bigquery-storage` packages.
 */
export async function loadBigQuerySdks(): Promise<BigQuerySdks> {
  if (sdksPromise !== null) {
    return sdksPromise;
  }
  sdksPromise = (async () => {
    try {
      const bqModule = await import('@google-cloud/bigquery');
      const bqStorageModule = await import('@google-cloud/bigquery-storage');
      return {
        BigQuery: bqModule.BigQuery,
        storage: bqStorageModule,
      };
    } catch (cause: unknown) {
      sdksPromise = null;
      throw new Error(
        "BigQueryAgentAnalyticsPlugin requires the optional '@google-cloud/bigquery' and '@google-cloud/bigquery-storage' packages. " +
          'Install them with: npm install @google-cloud/bigquery @google-cloud/bigquery-storage',
        {cause},
      );
    }
  })();
  return sdksPromise;
}

function extractCode(err: unknown): number | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'number'
  ) {
    return err.code;
  }
  return undefined;
}

/** Options for ensuring table existence. */
export interface EnsureTableOptions {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly clusteringFields: readonly string[];
  readonly bigquery?: BigQuery;
}

/**
 * Ensures the target events table exists with DAY time partitioning and clustering.
 */
export async function ensureTable(options: EnsureTableOptions): Promise<void> {
  const sdks = await loadBigQuerySdks();
  const BigQuery = sdks.BigQuery;
  const bq = options.bigquery ?? new BigQuery({projectId: options.projectId});
  const dataset = bq.dataset(options.datasetId);
  const table = dataset.table(options.tableId);

  try {
    await table.get();
    return;
  } catch (err: unknown) {
    const code = extractCode(err);
    if (code !== 404) {
      throw err;
    }
  }

  const mutableSchema = {
    fields: JSON.parse(JSON.stringify(EVENTS_SCHEMA)),
  };

  try {
    await dataset.createTable(options.tableId, {
      schema: mutableSchema,
      timePartitioning: {type: 'DAY', field: 'timestamp'},
      clustering: {fields: [...options.clusteringFields]},
      labels: {[SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION},
    });
  } catch (err: unknown) {
    const code = extractCode(err);
    if (code === 409) {
      await table.get();
      return;
    }
    throw err;
  }
}

/** Adapter exposing write and close operations on the BigQuery Storage Write API. */
export interface StorageWriter {
  readonly writeRows: (rows: readonly EventRow[]) => Promise<AppendResult>;
  readonly close: () => Promise<void>;
}

/** Options for creating a StorageWriter. */
export interface CreateStorageWriterOptions {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly writerClient?: bqStorage.managedwriter.WriterClient;
  readonly jsonWriter?: bqStorage.managedwriter.JSONWriter;
}

/**
 * Creates a {@link StorageWriter} on the `_default` stream using `WriterClient` and `JSONWriter`.
 */
export async function createStorageWriter(
  options: CreateStorageWriterOptions,
): Promise<StorageWriter> {
  const sdks = await loadBigQuerySdks();
  const storage = sdks.storage;
  const managedwriter = storage.managedwriter;
  const adapt = storage.adapt;

  const destinationTable = `projects/${options.projectId}/datasets/${options.datasetId}/tables/${options.tableId}`;
  const writerClient = options.writerClient ?? new managedwriter.WriterClient();

  const storageSchema = adapt.convertBigQuerySchemaToStorageTableSchema({
    fields: JSON.parse(JSON.stringify(EVENTS_SCHEMA)),
  });
  const protoDescriptor = adapt.convertStorageSchemaToProto2Descriptor(
    storageSchema,
    'EventRow',
  );

  let jsonWriter: bqStorage.managedwriter.JSONWriter;
  if (options.jsonWriter) {
    jsonWriter = options.jsonWriter;
  } else {
    const connection = await writerClient.createStreamConnection({
      destinationTable,
      streamType: 'DEFAULT',
    });
    jsonWriter = new managedwriter.JSONWriter({
      connection,
      protoDescriptor,
      traceId: `google-adk-bq-logger/${version}`,
    });
  }

  return {
    writeRows: async (rows: readonly EventRow[]): Promise<AppendResult> => {
      // Cast EventRow to JSONWriter's expected JSONObject array
      const pendingWrite = jsonWriter.appendRows(
        rows as unknown as Parameters<
          bqStorage.managedwriter.JSONWriter['appendRows']
        >[0],
      );
      const response = await pendingWrite.getResult();
      return {
        error: response.error
          ? {
              code: response.error.code ?? undefined,
              message: response.error.message ?? undefined,
            }
          : undefined,
        rowErrors: response.rowErrors ?? undefined,
      };
    },
    close: async (): Promise<void> => {
      try {
        jsonWriter.close();
      } catch {
        // Ignore close errors
      }
      try {
        writerClient.close();
      } catch {
        // Ignore close errors
      }
    },
  };
}
