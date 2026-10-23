/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type BigQuery, type Query} from '@google-cloud/bigquery';
import {type managedwriter} from '@google-cloud/bigquery-storage';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  type BigQueryLoggerConfig,
  resolveLoggerConfig,
} from '../../src/bigquery_analytics/config.js';
import {type BigQueryClient} from '../../src/bigquery_analytics/table_setup.js';
import {type EventRow} from '../../src/bigquery_analytics/types.js';
import {
  type AppendRowsOutcome,
  type RowAppender,
} from '../../src/bigquery_analytics/write_client.js';
import {WriterLifecycle} from '../../src/bigquery_analytics/writer_lifecycle.js';

const transport = vi.hoisted(() => ({
  respond: (): Promise<AppendRowsOutcome> => Promise.resolve({}),
  closes: 0,
  transportClose: (): Promise<void> => Promise.resolve(),
  ownsClient: [] as Array<boolean | undefined>,
}));

vi.mock(
  '../../src/bigquery_analytics/write_client.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../src/bigquery_analytics/write_client.js')
      >();
    const appender: RowAppender = {
      appendRows: () => transport.respond(),
      finalizeWriteStream: async () => undefined,
      close: () => {
        transport.closes += 1;
      },
    };
    return {
      ...original,
      createStorageRowAppender: ({ownsClient}: {ownsClient?: boolean}) => {
        transport.ownsClient.push(ownsClient);
        return appender;
      },
      createWriteClient: () =>
        ({
          close: () => undefined,
          getClient: () => ({close: () => transport.transportClose()}),
        }) as unknown as managedwriter.WriterClient,
    };
  },
);

function fakeBigQuery(
  query: (query: Query) => Promise<unknown> = () => Promise.resolve([[]]),
) {
  const createTable = vi.fn(() => Promise.resolve([{}]));
  const dataset = vi.fn(
    (
      _datasetId: string,
      _options?: {projectId?: string; location?: string},
    ) => ({
      table: () => ({
        getMetadata: () =>
          Promise.reject(Object.assign(new Error('missing'), {code: 404})),
        setMetadata: () => Promise.resolve([{}]),
      }),
      createTable,
    }),
  );
  const queryFn = vi.fn(query);
  const client: BigQueryClient = {
    dataset,
    query: (q) => queryFn(q) as Promise<ReadonlyArray<unknown>>,
  };
  return {
    bigQuery: client as unknown as BigQuery,
    createTable,
    dataset,
    query: queryFn,
  };
}

function lifecycle({
  bigQuery,
  config = {},
  writeClient = null,
  location,
}: {
  bigQuery: BigQuery;
  config?: Partial<BigQueryLoggerConfig>;
  writeClient?: managedwriter.WriterClient | null;
  location?: string;
}): WriterLifecycle {
  return new WriterLifecycle({
    projectId: 'p',
    datasetId: 'd',
    tableId: 't',
    location,
    config: resolveLoggerConfig({createViews: false, ...config}),
    deniedColumns: new Set(),
    bigQuery,
    storage: null,
    writeClient,
  });
}

function row(eventId: string): EventRow {
  return {
    timestamp: new Date(0),
    event_id: eventId,
    event_type: 'LLM_REQUEST',
    agent: 'agent',
    session_id: 's',
    invocation_id: 'i',
    user_id: 'u',
    trace_id: 't',
    span_id: 'sp',
    parent_span_id: null,
    status: 'OK',
    error_message: null,
    is_truncated: false,
  };
}

const onReleased = (): void => undefined;

afterEach(() => {
  transport.respond = () => Promise.resolve({});
  transport.closes = 0;
  transport.transportClose = () => Promise.resolve();
  transport.ownsClient = [];
  vi.restoreAllMocks();
});

describe('WriterLifecycle', () => {
  it('sends no location to the dataset or view DDL by default', async () => {
    const fake = fakeBigQuery();
    const writer = lifecycle({
      bigQuery: fake.bigQuery,
      config: {createViews: true},
    });
    await expect(writer.ensureStarted()).resolves.toBe('ok');
    expect(fake.dataset).toHaveBeenCalledWith('d', {projectId: 'p'});
    expect(fake.query.mock.calls[0]?.[0]).not.toHaveProperty('location');
    await writer.shutdown({onReleased});
  });

  it('passes an explicit location through', async () => {
    const fake = fakeBigQuery();
    const writer = lifecycle({
      bigQuery: fake.bigQuery,
      config: {createViews: true},
      location: 'EU',
    });
    await writer.ensureStarted();
    expect(fake.dataset).toHaveBeenCalledWith('d', {
      projectId: 'p',
      location: 'EU',
    });
    expect(fake.query.mock.calls[0]?.[0]).toMatchObject({location: 'EU'});
    await writer.shutdown({onReleased});
  });

  it('starts and accepts rows when the table is ready but views fail', async () => {
    const fake = fakeBigQuery(() => Promise.reject(new Error('no views')));
    const writer = lifecycle({
      bigQuery: fake.bigQuery,
      config: {createViews: true},
    });
    await expect(writer.ensureStarted()).resolves.toBe('ok');
    expect(writer.append(row('e0'))).toBe(true);
    await writer.flush();
    await writer.shutdown({onReleased});
    expect(fake.createTable).toHaveBeenCalledOnce();
  });

  it('never restarts after shutdown', async () => {
    const fake = fakeBigQuery();
    const writer = lifecycle({bigQuery: fake.bigQuery});
    await writer.ensureStarted();
    await writer.shutdown({onReleased});
    await expect(writer.ensureStarted()).resolves.toBe('aborted');
    expect(writer.started).toBe(false);
    expect(writer.append(row('late'))).toBe(false);
    expect(fake.createTable).toHaveBeenCalledOnce();
  });

  it('closes the appender on shutdown when the write client is supplied', async () => {
    const supplied = {} as managedwriter.WriterClient;
    const writer = lifecycle({
      bigQuery: fakeBigQuery().bigQuery,
      writeClient: supplied,
    });
    await writer.ensureStarted();
    await writer.shutdown({onReleased});
    expect(transport.closes).toBe(1);
  });

  it('lets the writer recycle connections only of a write client it created', async () => {
    const owned = lifecycle({bigQuery: fakeBigQuery().bigQuery});
    await owned.ensureStarted();
    await owned.shutdown({onReleased});
    const supplied = lifecycle({
      bigQuery: fakeBigQuery().bigQuery,
      writeClient: {} as managedwriter.WriterClient,
    });
    await supplied.ensureStarted();
    await supplied.shutdown({onReleased});
    expect(transport.ownsClient).toEqual([true, false]);
  });

  it('rethrows a teardown failure after releasing', async () => {
    transport.transportClose = () => Promise.reject(new Error('stuck'));
    const released = vi.fn();
    const writer = lifecycle({bigQuery: fakeBigQuery().bigQuery});
    await writer.ensureStarted();
    await expect(writer.shutdown({onReleased: released})).rejects.toThrow(
      'stuck',
    );
    expect(released).toHaveBeenCalledOnce();
  });

  it('bounds an owned transport close by the remaining per-call budget', async () => {
    transport.transportClose = () => new Promise<void>(() => undefined);
    const writer = lifecycle({
      bigQuery: fakeBigQuery().bigQuery,
      config: {shutdownTimeout: 5},
    });
    await writer.ensureStarted();
    const startedAt = performance.now();
    await writer.shutdown({timeoutSeconds: 0.05, onReleased});
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('keeps counting the writer drops while shutdown is draining', async () => {
    transport.respond = () => new Promise<AppendRowsOutcome>(() => undefined);
    const writer = lifecycle({
      bigQuery: fakeBigQuery().bigQuery,
      config: {queueMaxSize: 1},
    });
    await writer.ensureStarted();
    writer.append(row('e0'));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    writer.append(row('e1'));
    writer.append(row('e2'));
    expect(writer.getDropStats().queue_full).toBe(1);
    const shutdown = writer.shutdown({timeoutSeconds: 0.05, onReleased});
    expect(writer.getDropStats().queue_full).toBe(1);
    await shutdown;
    expect(writer.getDropStats()).toMatchObject({
      queue_full: 1,
      shutdown_timeout: 2,
    });
  });
});
