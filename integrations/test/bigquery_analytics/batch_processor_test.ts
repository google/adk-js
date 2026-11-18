/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type TableField} from '@google-cloud/bigquery';
import {logger} from '@google/adk';
import {afterEach, describe, expect, it, type MockInstance, vi} from 'vitest';
import {
  AppendTimeoutError,
  BatchProcessor,
} from '../../src/bigquery_analytics/batch_processor.js';
import {type RetryConfig} from '../../src/bigquery_analytics/config.js';
import {type EventRow} from '../../src/bigquery_analytics/types.js';
import {
  type AppendRowsOutcome,
  type EncodedRow,
  GRPC_CODE,
  type RowAppender,
  RowEncodingError,
} from '../../src/bigquery_analytics/write_client.js';

const TABLE = 'projects/p/datasets/d/tables/t';
const STREAM = `${TABLE}/streams/committed-1`;
const REPLACEMENT = `${TABLE}/streams/committed-2`;
const DEFAULT_STREAM = `${TABLE}/streams/_default`;

const SCHEMA: Array<TableField> = [
  {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
  {name: 'event_id', type: 'STRING', mode: 'NULLABLE'},
  {name: 'event_type', type: 'STRING', mode: 'NULLABLE'},
  {name: 'agent', type: 'STRING', mode: 'NULLABLE'},
  {name: 'session_id', type: 'STRING', mode: 'NULLABLE'},
  {name: 'invocation_id', type: 'STRING', mode: 'NULLABLE'},
  {name: 'user_id', type: 'STRING', mode: 'NULLABLE'},
  {name: 'trace_id', type: 'STRING', mode: 'NULLABLE'},
  {name: 'span_id', type: 'STRING', mode: 'NULLABLE'},
  {name: 'parent_span_id', type: 'STRING', mode: 'NULLABLE'},
  {name: 'content', type: 'JSON', mode: 'NULLABLE'},
  {
    name: 'content_parts',
    type: 'RECORD',
    mode: 'REPEATED',
    fields: [
      {name: 'mime_type', type: 'STRING', mode: 'NULLABLE'},
      {name: 'uri', type: 'STRING', mode: 'NULLABLE'},
      {
        name: 'object_ref',
        type: 'RECORD',
        mode: 'NULLABLE',
        fields: [
          {name: 'uri', type: 'STRING', mode: 'NULLABLE'},
          {name: 'version', type: 'STRING', mode: 'NULLABLE'},
          {name: 'authorizer', type: 'STRING', mode: 'NULLABLE'},
          {name: 'details', type: 'JSON', mode: 'NULLABLE'},
        ],
      },
      {name: 'text', type: 'STRING', mode: 'NULLABLE'},
      {name: 'part_index', type: 'INTEGER', mode: 'NULLABLE'},
      {name: 'part_attributes', type: 'STRING', mode: 'NULLABLE'},
      {name: 'storage_mode', type: 'STRING', mode: 'NULLABLE'},
    ],
  },
  {name: 'attributes', type: 'JSON', mode: 'NULLABLE'},
  {name: 'latency_ms', type: 'JSON', mode: 'NULLABLE'},
  {name: 'status', type: 'STRING', mode: 'NULLABLE'},
  {name: 'error_message', type: 'STRING', mode: 'NULLABLE'},
  {name: 'is_truncated', type: 'BOOLEAN', mode: 'NULLABLE'},
];

function row(eventId: string): EventRow {
  return {
    timestamp: new Date('2026-10-23T10:00:00.000Z'),
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

function rows(count: number): Array<EventRow> {
  const result: Array<EventRow> = [];
  for (let index = 0; index < count; index += 1) {
    result.push(row(`e${index}`));
  }
  return result;
}

function grpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), {code});
}

const ok: AppendRowsOutcome = {error: null, rowErrors: []};

function inBand(code: number, message: string): AppendRowsOutcome {
  return {error: {code, message}, rowErrors: []};
}

interface AppendCall {
  writeStream: string;
  rows: Array<EncodedRow>;
  offset: number | null;
  signal?: AbortSignal;
}

type Respond = (
  call: AppendCall,
  index: number,
) => Promise<AppendRowsOutcome> | AppendRowsOutcome;

interface FakeAppender {
  calls: Array<AppendCall>;
  finalized: Array<string>;
  closes: {count: number};
  appender: RowAppender;
}

function fakeAppender(
  respond: Respond = () => ok,
  finalize: (name: string) => Promise<void> = () => Promise.resolve(),
): FakeAppender {
  const calls: Array<AppendCall> = [];
  const finalized: Array<string> = [];
  const closes = {count: 0};
  return {
    calls,
    finalized,
    closes,
    appender: {
      appendRows: async ({writeStream, rows: encoded, offset, signal}) => {
        const call = {writeStream, rows: encoded, offset, signal};
        calls.push(call);
        return respond(call, calls.length);
      },
      finalizeWriteStream: async ({name}) => {
        finalized.push(name);
        await finalize(name);
      },
      close: () => {
        closes.count += 1;
      },
    },
  };
}

function neverSettles(): void {
  // The promise built on it never settles.
}

function never<T>(): Promise<T> {
  return new Promise<T>(neverSettles);
}

/** Lets pending promise callbacks and I/O callbacks run. */
async function ticks(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Whether `promise` settles within a generous `ms` safety margin. */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Timers that keep the process alive. */
function referencedTimers(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout').length;
}

function noDelay(maxRetries: number): RetryConfig {
  return {maxRetries, initialDelay: 0, multiplier: 1, maxDelay: 0};
}

interface ProcessorOverrides {
  queueMaxSize?: number;
  retryConfig?: RetryConfig;
  batchSize?: number;
  flushInterval?: number;
  shutdownTimeout?: number;
}

function defaultProcessor(
  appender: RowAppender,
  overrides: ProcessorOverrides = {},
): BatchProcessor {
  return new BatchProcessor({
    appender,
    schema: SCHEMA,
    destinationTable: TABLE,
    batchSize: overrides.batchSize ?? 1,
    flushInterval: overrides.flushInterval ?? 1,
    retryConfig: overrides.retryConfig ?? {
      maxRetries: 3,
      initialDelay: 1,
      multiplier: 2,
      maxDelay: 10,
    },
    queueMaxSize: overrides.queueMaxSize ?? 10,
    shutdownTimeout: overrides.shutdownTimeout ?? 10,
    exactlyOnceDelivery: false,
  });
}

function committedProcessor(
  appender: RowAppender,
  {
    maxRetries = 0,
    createStream,
  }: {maxRetries?: number; createStream?: () => Promise<string>} = {},
): BatchProcessor {
  return new BatchProcessor({
    appender,
    schema: SCHEMA,
    destinationTable: TABLE,
    writeStream: STREAM,
    batchSize: 2,
    flushInterval: 1,
    retryConfig: noDelay(maxRetries),
    queueMaxSize: 10,
    shutdownTimeout: 1,
    exactlyOnceDelivery: true,
    createStream,
  });
}

function nonZero(stats: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(stats).filter(([, count]) => count > 0),
  );
}

function logged(spy: MockInstance<(...args: Array<unknown>) => void>): string {
  return spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BatchProcessor drop accounting', () => {
  it('flush waits for a dequeued batch whose write is still in flight', async () => {
    let release: ((value: AppendRowsOutcome) => void) | undefined;
    const {appender, calls} = fakeAppender(
      () =>
        new Promise<AppendRowsOutcome>((resolve) => {
          release = resolve;
        }),
    );
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append(row('e0'));
    await vi.waitUntil(() => calls.length === 1);

    let flushed = false;
    const flush = (async (): Promise<void> => {
      await processor.flush();
      flushed = true;
    })();
    await ticks();
    expect(flushed).toBe(false);

    release?.(ok);
    await flush;
    expect(flushed).toBe(true);
    await processor.close();
  });

  it('counts queue_full drops while the writer is not started', () => {
    const processor = defaultProcessor(fakeAppender().appender, {
      queueMaxSize: 1,
    });
    processor.append(row('e0'));
    processor.append(row('e1'));
    processor.append(row('e2'));
    expect(processor.getDropStats().queue_full).toBe(2);
    expect(processor.droppedEventCount).toBe(2);
  });

  it('counts retry_exhausted drops after a retryable in-band error', async () => {
    const {appender, calls} = fakeAppender(() =>
      inBand(GRPC_CODE.UNAVAILABLE, 'unavailable'),
    );
    const processor = defaultProcessor(appender, {
      retryConfig: noDelay(0),
      batchSize: 2,
    });
    processor.start();
    processor.append(row('e0'));
    processor.append(row('e1'));
    await processor.flush();
    expect(calls).toHaveLength(1);
    expect(processor.getDropStats().retry_exhausted).toBe(2);
    expect(processor.droppedEventCount).toBe(2);
    await processor.close();
  });

  it('retries a retryable in-band error and then writes the batch', async () => {
    const {appender, calls} = fakeAppender((_call, index) =>
      index === 1 ? inBand(GRPC_CODE.INTERNAL, 'internal') : ok,
    );
    const processor = defaultProcessor(appender, {retryConfig: noDelay(1)});
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    expect(calls).toHaveLength(2);
    expect(processor.droppedEventCount).toBe(0);
    await processor.close();
  });

  it('counts an in-band non-retryable rejection without logging row content', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const {appender} = fakeAppender(() =>
      inBand(GRPC_CODE.INVALID_ARGUMENT, 'bad request'),
    );
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append(row('NONRETRYABLE-ROW-SECRET'));
    await processor.flush();
    expect(processor.getDropStats().non_retryable).toBe(1);
    expect(processor.droppedEventCount).toBe(1);
    expect(logged(errorSpy)).not.toContain('NONRETRYABLE-ROW-SECRET');
    expect(logged(errorSpy)).toContain('1 row(s) dropped');
    await processor.close();
  });

  it.each([
    GRPC_CODE.UNAUTHENTICATED,
    GRPC_CODE.INVALID_ARGUMENT,
    GRPC_CODE.FAILED_PRECONDITION,
  ])(
    'counts a stream-level rejection with code %i as non_retryable, never retried',
    async (code) => {
      const errorSpy = vi.spyOn(logger, 'error');
      const {appender, calls} = fakeAppender(() =>
        Promise.reject(grpcError(code, 'rejected')),
      );
      const processor = defaultProcessor(appender, {
        retryConfig: noDelay(1),
        batchSize: 2,
      });
      processor.start();
      processor.append(row('e0'));
      processor.append(row('e1'));
      await processor.flush();
      expect(calls).toHaveLength(1);
      expect(processor.getDropStats().non_retryable).toBe(2);
      expect(processor.getDropStats().unexpected_error).toBe(0);
      expect(logged(errorSpy)).toContain('Non-retryable BigQuery error');
      expect(logged(errorSpy)).toContain('2 row(s) dropped');
      await processor.close();
    },
  );

  it('logs the schema hint for a stream-level schema mismatch', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const {appender, calls} = fakeAppender(() =>
      Promise.reject(
        grpcError(GRPC_CODE.INVALID_ARGUMENT, 'Schema mismatch: field x'),
      ),
    );
    const processor = defaultProcessor(appender, {
      retryConfig: noDelay(1),
      batchSize: 2,
    });
    processor.start();
    processor.append(row('e0'));
    processor.append(row('e1'));
    await processor.flush();
    expect(calls).toHaveLength(1);
    expect(processor.getDropStats().non_retryable).toBe(2);
    expect(logged(errorSpy)).toContain(
      'BigQuery Schema Mismatch: Schema mismatch: field x',
    );
    expect(logged(errorSpy)).not.toContain('Non-retryable BigQuery error');
    await processor.close();
  });

  it.each([
    ['in-band', () => inBand(GRPC_CODE.PERMISSION_DENIED, 'permission denied')],
    [
      'raised',
      () => Promise.reject(grpcError(GRPC_CODE.PERMISSION_DENIED, 'forbidden')),
    ],
  ] as const)(
    'counts %s PERMISSION_DENIED as permission_denied',
    async (_mode, respond) => {
      const {appender, calls} = fakeAppender(respond);
      const processor = defaultProcessor(appender);
      processor.start();
      processor.append(row('e0'));
      await processor.flush();
      expect(calls).toHaveLength(1);
      expect(processor.getDropStats().permission_denied).toBe(1);
      expect(processor.droppedEventCount).toBe(1);
      await processor.close();
    },
  );

  it.each([
    ['in-band', () => inBand(GRPC_CODE.NOT_FOUND, 'not found')],
    [
      'raised',
      () => Promise.reject(grpcError(GRPC_CODE.NOT_FOUND, 'table not found')),
    ],
  ] as const)(
    'counts %s NOT_FOUND as not_found in default mode',
    async (_mode, respond) => {
      const {appender} = fakeAppender(respond);
      const processor = defaultProcessor(appender);
      processor.start();
      processor.append(row('e0'));
      await processor.flush();
      expect(processor.getDropStats().not_found).toBe(1);
      await processor.close();
    },
  );

  it('counts an error without a gRPC code as unexpected_error', async () => {
    const {appender} = fakeAppender(() => Promise.reject(new Error('boom')));
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    expect(nonZero(processor.getDropStats())).toEqual({unexpected_error: 1});
    await processor.close();
  });

  it('drops appends after shutdown as shutdown_cancelled', async () => {
    const processor = defaultProcessor(fakeAppender().appender);
    await processor.shutdown();
    processor.append(row('e0'));
    expect(processor.getDropStats().shutdown_cancelled).toBe(1);
  });
});

describe('BatchProcessor row serialization', () => {
  it('serializes JSON columns, encoding strings as JSON string literals', async () => {
    const {appender, calls} = fakeAppender();
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append({
      ...row('e0'),
      content: {prompt: [{role: 'user', content: 'hi'}]},
      attributes: {already: 'json'},
      latency_ms: 'plain text',
      content_parts: [
        {
          mime_type: 'text/plain',
          uri: null,
          object_ref: {
            uri: 'gs://b/o',
            version: null,
            authorizer: 'us.conn',
            details: {gcs_metadata: {content_type: 'text/plain'}},
          },
          text: 'hi',
          part_index: 0,
          part_attributes: '{}',
          storage_mode: 'GCS_REFERENCE',
        },
      ],
    });
    await processor.flush();

    const [encoded] = calls[0]?.rows ?? [];
    expect(encoded?.timestamp).toEqual(new Date('2026-10-23T10:00:00.000Z'));
    expect(encoded?.content).toBe(
      '{"prompt":[{"role":"user","content":"hi"}]}',
    );
    expect(encoded?.attributes).toBe('{"already":"json"}');
    expect(encoded?.latency_ms).toBe('"plain text"');

    processor.append({...row('e1'), content: '{"looks":"like json"}'});
    await processor.flush();
    expect(calls[1]?.rows[0]?.content).toBe('"{\\"looks\\":\\"like json\\"}"');
    expect(encoded?.content_parts).toEqual([
      {
        mime_type: 'text/plain',
        uri: null,
        object_ref: {
          uri: 'gs://b/o',
          version: null,
          authorizer: 'us.conn',
          details: '{"gcs_metadata":{"content_type":"text/plain"}}',
        },
        text: 'hi',
        part_index: 0,
        part_attributes: '{}',
        storage_mode: 'GCS_REFERENCE',
      },
    ]);
    expect(encoded?.is_truncated).toBe(false);
    await processor.close();
  });

  it('omits columns the row leaves undefined, such as projected-out payload columns', async () => {
    const {appender, calls} = fakeAppender();
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    expect(Object.keys(calls[0]?.rows[0] ?? {})).not.toContain('content');
    await processor.close();
  });

  it('counts a batch the encoder rejects as arrow_prep_failed', async () => {
    const appender: RowAppender = {
      ...fakeAppender().appender,
      appendRows: () =>
        Promise.reject(new RowEncodingError(new Error('bad field'))),
    };
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    expect(nonZero(processor.getDropStats())).toEqual({arrow_prep_failed: 1});
    await processor.close();
  });
});

describe('BatchProcessor default stream', () => {
  it('appends to the default stream without an offset', async () => {
    const {appender, calls} = fakeAppender();
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    expect(
      calls.map(({writeStream, offset}) => ({writeStream, offset})),
    ).toEqual([{writeStream: DEFAULT_STREAM, offset: null}]);
    await processor.close();
  });

  it('retries an append that ended without a response, then counts it', async () => {
    const {appender, calls} = fakeAppender(() => null);
    const processor = defaultProcessor(appender, {retryConfig: noDelay(1)});
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    expect(calls).toHaveLength(2);
    expect(nonZero(processor.getDropStats())).toEqual({retry_exhausted: 1});
    await processor.close();
  });

  it('writes a batch whose first append ended without a response on retry', async () => {
    const {appender, calls} = fakeAppender((_call, index) =>
      index === 1 ? null : ok,
    );
    const processor = defaultProcessor(appender, {retryConfig: noDelay(1)});
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    expect(calls).toHaveLength(2);
    expect(processor.droppedEventCount).toBe(0);
    await processor.close();
  });

  it('never finalizes the default stream', async () => {
    const {appender, finalized} = fakeAppender();
    const processor = defaultProcessor(appender);
    await processor.close();
    expect(finalized).toEqual([]);
  });
});

describe('BatchProcessor exactly-once delivery', () => {
  async function write(
    processor: BatchProcessor,
    count: number,
  ): Promise<void> {
    for (const r of rows(count)) {
      processor.append(r);
    }
    await processor.flush();
  }

  function started(processor: BatchProcessor): BatchProcessor {
    processor.start();
    return processor;
  }

  it('poisons the stream when the append ends without a response', async () => {
    const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
    const {appender, calls} = fakeAppender((_call, index) =>
      index === 1 ? null : ok,
    );
    const processor = started(committedProcessor(appender, {createStream}));
    await write(processor, 1);
    expect(calls).toHaveLength(1);
    expect(processor.getDropStats().retry_exhausted).toBe(1);
    await write(processor, 1);
    expect(createStream).toHaveBeenCalledOnce();
    expect(calls[1]?.writeStream).toBe(REPLACEMENT);
    await processor.close();
  });

  it('advances offsets only after confirmed batches', async () => {
    const {appender, calls} = fakeAppender();
    const processor = started(committedProcessor(appender));
    await write(processor, 2);
    await write(processor, 1);
    await write(processor, 1);
    expect(calls.map(({offset}) => offset)).toEqual([0, 2, 3]);
    await processor.close();
  });

  it.each([
    [
      'raised',
      () =>
        Promise.reject(
          grpcError(GRPC_CODE.ALREADY_EXISTS, 'offset already exists'),
        ),
    ],
    [
      'in-band',
      () => inBand(GRPC_CODE.ALREADY_EXISTS, 'offset already exists'),
    ],
  ] as const)(
    'reuses the offset on retry and confirms delivery on %s ALREADY_EXISTS',
    async (_mode, alreadyExists) => {
      const {appender, calls} = fakeAppender((_call, index) => {
        if (index === 1) {
          return Promise.reject(grpcError(GRPC_CODE.UNAVAILABLE, 'retry'));
        }
        return index === 2 ? alreadyExists() : ok;
      });
      const processor = started(committedProcessor(appender, {maxRetries: 1}));
      await write(processor, 2);
      await write(processor, 1);
      expect(calls.map(({offset}) => offset)).toEqual([0, 0, 2]);
      expect(processor.droppedEventCount).toBe(0);
      await processor.close();
    },
  );

  it('stays desynchronized when a later retry is rejected after an ambiguous attempt', async () => {
    const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
    const {appender, calls} = fakeAppender((call, index) => {
      if (index === 1) {
        return Promise.reject(new AppendTimeoutError());
      }
      if (index === 2) {
        return inBand(GRPC_CODE.UNAVAILABLE, 'unavailable');
      }
      return call.writeStream === STREAM
        ? inBand(GRPC_CODE.ALREADY_EXISTS, 'offset already exists')
        : ok;
    });
    const processor = started(
      committedProcessor(appender, {maxRetries: 1, createStream}),
    );
    await write(processor, 2);
    await write(processor, 1);
    await write(processor, 1);
    expect(calls.map(({writeStream}) => writeStream)).toEqual([
      STREAM,
      STREAM,
      REPLACEMENT,
      REPLACEMENT,
    ]);
    expect(calls[3]?.offset).toBe(1);
    expect(processor.getDropStats().retry_exhausted).toBe(2);
    await processor.close();
  });

  it.each([
    [GRPC_CODE.INVALID_ARGUMENT, 'invalid argument', 'non_retryable'],
    [GRPC_CODE.PERMISSION_DENIED, 'permission denied', 'permission_denied'],
  ] as const)(
    'rotates the stream when in-band code %i follows an ambiguous attempt',
    async (code, message, reason) => {
      const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
      const {appender, calls} = fakeAppender((_call, index) => {
        if (index === 1) {
          return Promise.reject(new AppendTimeoutError());
        }
        return index === 2 ? inBand(code, message) : ok;
      });
      const processor = started(
        committedProcessor(appender, {maxRetries: 1, createStream}),
      );
      await write(processor, 1);
      await write(processor, 1);
      await write(processor, 1);
      expect(calls.map(({writeStream}) => writeStream)).toEqual([
        STREAM,
        STREAM,
        REPLACEMENT,
        REPLACEMENT,
      ]);
      expect(calls[3]?.offset).toBe(1);
      expect(processor.getDropStats()[reason]).toBe(1);
      expect(createStream).toHaveBeenCalledOnce();
      await processor.close();
    },
  );

  it.each([GRPC_CODE.UNAUTHENTICATED, GRPC_CODE.PERMISSION_DENIED])(
    'rotates the stream when raised code %i follows an ambiguous attempt',
    async (code) => {
      const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
      const {appender, calls} = fakeAppender((_call, index) => {
        if (index === 1) {
          return Promise.reject(new AppendTimeoutError());
        }
        return index === 2 ? Promise.reject(grpcError(code, 'rejected')) : ok;
      });
      const processor = started(
        committedProcessor(appender, {maxRetries: 1, createStream}),
      );
      await write(processor, 1);
      await write(processor, 1);
      expect(calls.map(({writeStream}) => writeStream)).toEqual([
        STREAM,
        STREAM,
        REPLACEMENT,
      ]);
      expect(calls[2]?.offset).toBe(0);
      expect(Object.values(nonZero(processor.getDropStats()))).toEqual([1]);
      expect(createStream).toHaveBeenCalledOnce();
      await processor.close();
    },
  );

  it.each([
    [
      'raised PERMISSION_DENIED',
      grpcError(GRPC_CODE.PERMISSION_DENIED, 'permission denied'),
      'permission_denied',
    ],
    [
      'raised UNAUTHENTICATED',
      grpcError(GRPC_CODE.UNAUTHENTICATED, 'rejected'),
      'non_retryable',
    ],
    [
      'raised schema mismatch',
      grpcError(GRPC_CODE.INVALID_ARGUMENT, 'Schema mismatch: field x'),
      'non_retryable',
    ],
  ] as const)(
    'keeps the stream and its offset after a first-attempt %s',
    async (_label, error, reason) => {
      const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
      const {appender, calls} = fakeAppender((_call, index) =>
        index === 1 ? Promise.reject(error) : ok,
      );
      const processor = started(
        committedProcessor(appender, {maxRetries: 1, createStream}),
      );
      await write(processor, 1);
      expect(nonZero(processor.getDropStats())).toEqual({[reason]: 1});
      await write(processor, 1);
      await write(processor, 1);
      expect(calls.map(({offset}) => offset)).toEqual([0, 0, 1]);
      expect(calls.map(({writeStream}) => writeStream)).toEqual([
        STREAM,
        STREAM,
        STREAM,
      ]);
      expect(createStream).not.toHaveBeenCalled();
      await processor.close();
    },
  );

  it.each([GRPC_CODE.INVALID_ARGUMENT, GRPC_CODE.FAILED_PRECONDITION])(
    'rotates a stream rejected at the RPC level with code %i',
    async (code) => {
      const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
      const {appender, calls} = fakeAppender((_call, index) =>
        index === 1 ? Promise.reject(grpcError(code, 'rejected')) : ok,
      );
      const processor = started(
        committedProcessor(appender, {maxRetries: 1, createStream}),
      );
      await write(processor, 1);
      expect(nonZero(processor.getDropStats())).toEqual({non_retryable: 1});
      await write(processor, 1);
      expect(calls.map(({offset}) => offset)).toEqual([0, 0]);
      expect(calls.map(({writeStream}) => writeStream)).toEqual([
        STREAM,
        REPLACEMENT,
      ]);
      expect(createStream).toHaveBeenCalledOnce();
      await processor.close();
    },
  );

  it.each([
    [GRPC_CODE.INVALID_ARGUMENT, 'invalid argument'],
    [GRPC_CODE.INVALID_ARGUMENT, 'Schema mismatch: field x'],
    [GRPC_CODE.FAILED_PRECONDITION, 'failed precondition'],
  ] as const)(
    'keeps the stream after a first-attempt in-band rejection %i "%s"',
    async (code, message) => {
      const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
      const {appender, calls} = fakeAppender((_call, index) =>
        index === 1 ? inBand(code, message) : ok,
      );
      const processor = started(
        committedProcessor(appender, {maxRetries: 1, createStream}),
      );
      await write(processor, 1);
      expect(nonZero(processor.getDropStats())).toEqual({non_retryable: 1});
      await write(processor, 1);
      expect(calls.map(({offset}) => offset)).toEqual([0, 0]);
      expect(calls.map(({writeStream}) => writeStream)).toEqual([
        STREAM,
        STREAM,
      ]);
      expect(createStream).not.toHaveBeenCalled();
      await processor.close();
    },
  );

  it.each([
    [
      'raised',
      () =>
        Promise.reject(
          grpcError(GRPC_CODE.ALREADY_EXISTS, 'offset already exists'),
        ),
    ],
    [
      'in-band',
      () => inBand(GRPC_CODE.ALREADY_EXISTS, 'offset already exists'),
    ],
  ] as const)(
    'treats a first-attempt %s ALREADY_EXISTS as an offset conflict',
    async (_mode, alreadyExists) => {
      const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
      const {appender, calls} = fakeAppender((_call, index) =>
        index === 1 ? alreadyExists() : ok,
      );
      const processor = started(
        committedProcessor(appender, {maxRetries: 1, createStream}),
      );
      await write(processor, 1);
      expect(processor.getDropStats().offset_conflict).toBe(1);
      await write(processor, 1);
      expect(calls[1]).toMatchObject({writeStream: REPLACEMENT, offset: 0});
      await processor.close();
    },
  );

  it.each([
    [
      'raised NOT_FOUND',
      () => Promise.reject(grpcError(GRPC_CODE.NOT_FOUND, 'stream gone')),
    ],
    [
      'raised OUT_OF_RANGE',
      () =>
        Promise.reject(grpcError(GRPC_CODE.OUT_OF_RANGE, 'offset rejected')),
    ],
    ['in-band NOT_FOUND', () => inBand(GRPC_CODE.NOT_FOUND, 'offset rejected')],
    [
      'in-band OUT_OF_RANGE',
      () => inBand(GRPC_CODE.OUT_OF_RANGE, 'offset rejected'),
    ],
  ] as const)(
    'rotates before the next batch after %s, finalizing the old stream at rotation',
    async (_label, conflict) => {
      const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
      const {appender, calls, finalized} = fakeAppender((_call, index) =>
        index === 1 ? conflict() : ok,
      );
      const processor = started(committedProcessor(appender, {createStream}));
      await write(processor, 1);
      await write(processor, 1);
      expect(processor.getDropStats().offset_conflict).toBe(1);
      expect(calls.map(({offset}) => offset)).toEqual([0, 0]);
      expect(calls.map(({writeStream}) => writeStream)).toEqual([
        STREAM,
        REPLACEMENT,
      ]);
      expect(createStream).toHaveBeenCalledOnce();
      await vi.waitUntil(() => finalized.length === 1);
      expect(finalized).toEqual([STREAM]);
      await processor.close();
      expect(finalized).toEqual([STREAM, REPLACEMENT]);
    },
  );

  it('does not wait for the old stream to finalize before writing to its replacement', async () => {
    const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
    const {appender, calls} = fakeAppender(
      (_call, index) =>
        index === 1 ? inBand(GRPC_CODE.OUT_OF_RANGE, 'offset rejected') : ok,
      () => never<undefined>(),
    );
    const processor = started(committedProcessor(appender, {createStream}));
    await write(processor, 1);
    await write(processor, 1);
    expect(calls[1]).toMatchObject({writeStream: REPLACEMENT, offset: 0});
  });

  it('drops batches during the rotation backoff after a failed replacement', async () => {
    const createStream = vi.fn(() =>
      Promise.reject(grpcError(GRPC_CODE.UNAVAILABLE, 'quota unavailable')),
    );
    const {appender, calls} = fakeAppender((_call, index) =>
      index === 1 ? inBand(GRPC_CODE.OUT_OF_RANGE, 'offset rejected') : ok,
    );
    const processor = started(committedProcessor(appender, {createStream}));
    await write(processor, 1);
    await write(processor, 1);
    await write(processor, 2);
    expect(createStream).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(processor.getDropStats().offset_conflict).toBe(4);
    await processor.close();
  });

  it('poisons and rotates the stream when retries are exhausted after an ambiguous send', async () => {
    const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
    const {appender, calls} = fakeAppender((_call, index) =>
      index === 1 ? Promise.reject(new AppendTimeoutError()) : ok,
    );
    const processor = started(committedProcessor(appender, {createStream}));
    await write(processor, 1);
    await write(processor, 1);
    await write(processor, 1);
    expect(processor.getDropStats().retry_exhausted).toBe(1);
    expect(calls.map(({offset}) => offset)).toEqual([0, 0, 1]);
    expect(createStream).toHaveBeenCalledOnce();
    await processor.close();
  });

  it('retries a failed finalization on the next shutdown', async () => {
    let attempts = 0;
    const {appender, finalized} = fakeAppender(
      () => ok,
      () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(grpcError(GRPC_CODE.UNAVAILABLE, 'try again'))
          : Promise.resolve();
      },
    );
    const processor = committedProcessor(appender);
    await processor.shutdown();
    await processor.shutdown();
    await processor.shutdown();
    expect(finalized).toEqual([STREAM, STREAM]);
  });

  it.each(['shutdown', 'close'] as const)(
    'bounds %s finalization by the remaining close budget',
    async (method) => {
      let finalizeStarted = false;
      const {appender} = fakeAppender(
        () => ok,
        () => {
          finalizeStarted = true;
          return never<undefined>();
        },
      );
      const processor = new BatchProcessor({
        appender,
        schema: SCHEMA,
        destinationTable: TABLE,
        writeStream: STREAM,
        batchSize: 1,
        flushInterval: 1,
        retryConfig: noDelay(0),
        queueMaxSize: 10,
        shutdownTimeout: 0.05,
        exactlyOnceDelivery: true,
      });
      const closing =
        method === 'shutdown'
          ? processor.shutdown({timeoutSeconds: 0.05})
          : processor.close();
      await expect(settlesWithin(closing, 2000)).resolves.toBe(true);
      expect(finalizeStarted).toBe(true);
    },
  );
  it('abandons timed-out finalization at shutdown without holding a timer or starting more', async () => {
    const createStream = vi.fn(() => Promise.resolve(REPLACEMENT));
    const {appender, finalized} = fakeAppender(
      (_call, index) =>
        index === 1 ? inBand(GRPC_CODE.OUT_OF_RANGE, 'offset rejected') : ok,
      () => never<undefined>(),
    );
    const processor = started(committedProcessor(appender, {createStream}));
    await write(processor, 1);
    await write(processor, 1);
    await vi.waitUntil(() => finalized.length === 1);
    const timersBefore = referencedTimers();

    const startedAt = performance.now();
    await processor.shutdown({timeoutSeconds: 0.05});
    expect(performance.now() - startedAt).toBeLessThan(1000);
    await ticks();

    expect(referencedTimers()).toBeLessThan(timersBefore);
    expect(finalized).toEqual([STREAM]);
    await processor.close();
    await ticks();
    expect(finalized).toEqual([STREAM]);
  });
});

describe('BatchProcessor shutdown', () => {
  function hungProcessor(): FakeAppender & {processor: BatchProcessor} {
    const fake = fakeAppender(() => never<AppendRowsOutcome>());
    return {
      ...fake,
      processor: defaultProcessor(fake.appender, {
        flushInterval: 0.05,
        shutdownTimeout: 0.1,
      }),
    };
  }

  it('counts the in-flight batch and queued rows stranded by a shutdown timeout', async () => {
    const {processor, calls} = hungProcessor();
    processor.start();
    processor.append(row('e0'));
    await vi.waitUntil(() => calls.length === 1);
    processor.append(row('e1'));
    await processor.shutdown({timeoutSeconds: 0.1});
    expect(processor.getDropStats().shutdown_timeout).toBe(2);
  });

  it('close counts stranded rows like shutdown', async () => {
    const {processor, calls} = hungProcessor();
    processor.start();
    processor.append(row('e0'));
    await vi.waitUntil(() => calls.length === 1);
    processor.append(row('e1'));
    await processor.close();
    expect(processor.getDropStats().shutdown_timeout).toBe(2);
  });

  it('drains queued rows written before shutdown', async () => {
    const {appender, calls} = fakeAppender();
    const processor = defaultProcessor(appender, {batchSize: 2});
    processor.start();
    for (const r of rows(3)) {
      processor.append(r);
    }
    await processor.shutdown();
    expect(calls.map((call) => call.rows.length)).toEqual([2, 1]);
    expect(processor.droppedEventCount).toBe(0);
  });
});

describe('BatchProcessor terminal row reservation', () => {
  function terminal(eventId: string, eventType: string): EventRow {
    return {...row(eventId), event_type: eventType};
  }

  it.each(['INVOCATION_COMPLETED', 'INVOCATION_ERROR'])(
    'keeps reserved capacity for %s under a backlog of ordinary rows',
    (eventType) => {
      const processor = defaultProcessor(fakeAppender().appender, {
        queueMaxSize: 10,
      });
      for (const r of rows(10)) {
        processor.append(r);
      }
      expect(processor.getDropStats().queue_full).toBe(2);
      processor.append(terminal('done', eventType));
      processor.append(terminal('done-2', eventType));
      expect(processor.getDropStats().queue_full).toBe(2);
      processor.append(terminal('done-3', eventType));
      expect(processor.getDropStats().queue_full).toBe(3);
    },
  );

  it.each([
    [1, 1],
    [2, 1],
    [3, 1],
    [500, 495],
  ])(
    'a queue of %i accepts %i ordinary row(s) before reserving the rest',
    (queueMaxSize, accepted) => {
      const processor = defaultProcessor(fakeAppender().appender, {
        queueMaxSize,
      });
      for (const r of rows(queueMaxSize)) {
        processor.append(r);
      }
      expect(processor.getDropStats().queue_full).toBe(queueMaxSize - accepted);
      processor.append(terminal('done', 'INVOCATION_COMPLETED'));
      expect(processor.getDropStats().queue_full).toBe(
        queueMaxSize - accepted + (accepted === queueMaxSize ? 1 : 0),
      );
    },
  );
});

describe('BatchProcessor error classification', () => {
  it.each([GRPC_CODE.UNKNOWN, GRPC_CODE.DATA_LOSS])(
    'drops a raised code %i as unexpected_error without retrying',
    async (code) => {
      const {appender, calls} = fakeAppender(() =>
        Promise.reject(grpcError(code, 'lost')),
      );
      const processor = defaultProcessor(appender, {retryConfig: noDelay(3)});
      processor.start();
      processor.append(row('e0'));
      await processor.flush();
      expect(calls).toHaveLength(1);
      expect(nonZero(processor.getDropStats())).toEqual({unexpected_error: 1});
      await processor.close();
    },
  );

  it.each([
    [403, 'permission_denied'],
    [404, 'not_found'],
  ])('classifies an HTTP %i error as %s', async (code, reason) => {
    const {appender} = fakeAppender(() =>
      Promise.reject(grpcError(code, 'http error')),
    );
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    expect(nonZero(processor.getDropStats())).toEqual({[reason]: 1});
    await processor.close();
  });

  it('resends the rows a row-level rejection did not name', async () => {
    const {appender, calls} = fakeAppender((_call, index) =>
      index === 1
        ? {
            error: {code: GRPC_CODE.INVALID_ARGUMENT, message: 'bad row'},
            rowErrors: [{index: 1, code: 1, message: 'bad'}],
          }
        : ok,
    );
    const processor = defaultProcessor(appender, {batchSize: 3});
    for (const r of rows(3)) {
      processor.append(r);
    }
    processor.start();
    await processor.flush();
    expect(calls.map((call) => call.rows.map((r) => r['event_id']))).toEqual([
      ['e0', 'e1', 'e2'],
      ['e0', 'e2'],
    ]);
    expect(nonZero(processor.getDropStats())).toEqual({non_retryable: 1});
    await processor.close();
  });

  it('drops the whole batch when the row errors name no index', async () => {
    const {appender, calls} = fakeAppender(() => ({
      error: {code: GRPC_CODE.INVALID_ARGUMENT, message: 'bad row'},
      rowErrors: [{code: 1, message: 'bad'}],
    }));
    const processor = defaultProcessor(appender, {batchSize: 2});
    for (const r of rows(2)) {
      processor.append(r);
    }
    processor.start();
    await processor.flush();
    expect(calls).toHaveLength(1);
    expect(nonZero(processor.getDropStats())).toEqual({non_retryable: 2});
    await processor.close();
  });

  it('writes valid JSON text for a JSON value that cannot be stringified', async () => {
    const {appender, calls} = fakeAppender();
    const processor = defaultProcessor(appender);
    processor.start();
    processor.append({
      ...row('e0'),
      // A BigInt reaches the encoder only past the row types.
      content: {big: 1n} as unknown as EventRow['content'],
    });
    await processor.flush();
    const content = calls[0]?.rows[0]?.['content'];
    expect(typeof content).toBe('string');
    expect(() => JSON.parse(String(content))).not.toThrow();
    await processor.close();
  });
});

describe('BatchProcessor lifecycle', () => {
  it('flush waits for every row of a multi-row batch, written in order', async () => {
    const releases: Array<() => void> = [];
    const {appender, calls} = fakeAppender(
      () =>
        new Promise<AppendRowsOutcome>((resolve) => {
          releases.push(() => resolve(ok));
        }),
    );
    const processor = defaultProcessor(appender, {batchSize: 2});
    processor.start();
    processor.append(row('e0'));
    await vi.waitUntil(() => calls.length === 1);
    processor.append(row('e1'));
    processor.append(row('e2'));
    let flushed = false;
    const flush = processor.flush().then(() => {
      flushed = true;
    });
    releases.shift()?.();
    await vi.waitUntil(() => calls.length === 2);
    await ticks();
    expect(flushed).toBe(false);
    expect(calls).toHaveLength(2);
    releases.shift()?.();
    await flush;
    expect(calls.map((call) => call.rows.length)).toEqual([1, 2]);
    await processor.close();
  });

  it('shutdown defaults its budget to shutdownTimeout', async () => {
    const {appender, calls} = fakeAppender(() => never<AppendRowsOutcome>());
    const processor = defaultProcessor(appender, {shutdownTimeout: 0.05});
    processor.start();
    processor.append(row('e0'));
    await vi.waitUntil(() => calls.length === 1);
    await expect(settlesWithin(processor.shutdown(), 2000)).resolves.toBe(true);
    expect(processor.getDropStats().shutdown_timeout).toBe(1);
  });

  it('aborts an in-flight append that shutdown counted as dropped', async () => {
    const {appender, calls} = fakeAppender(() => never<AppendRowsOutcome>());
    const processor = defaultProcessor(appender, {shutdownTimeout: 0.05});
    processor.start();
    processor.append(row('e0'));
    await vi.waitUntil(() => calls.length === 1);
    expect(calls[0]?.signal?.aborted).toBe(false);
    await processor.shutdown();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it.each(['shutdown', 'close'] as const)(
    '%s closes the appender once',
    async (method) => {
      const {appender, closes} = fakeAppender();
      const processor = defaultProcessor(appender);
      processor.start();
      await processor[method]();
      await processor.close();
      expect(closes.count).toBe(1);
    },
  );

  it('does not hang shutdown on a pending stream replacement, and never writes to a late replacement', async () => {
    let resolveStream: ((name: string) => void) | undefined;
    const createStream = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const {appender, calls, finalized} = fakeAppender((_call, index) =>
      index === 1 ? inBand(GRPC_CODE.OUT_OF_RANGE, 'offset rejected') : ok,
    );
    const processor = new BatchProcessor({
      appender,
      schema: SCHEMA,
      destinationTable: TABLE,
      writeStream: STREAM,
      batchSize: 1,
      flushInterval: 1,
      retryConfig: noDelay(0),
      queueMaxSize: 10,
      shutdownTimeout: 0.05,
      exactlyOnceDelivery: true,
      createStream,
    });
    processor.start();
    processor.append(row('e0'));
    await processor.flush();
    processor.append(row('e1'));
    await vi.waitUntil(() => createStream.mock.calls.length === 1);

    await expect(
      settlesWithin(processor.shutdown({timeoutSeconds: 0.05}), 2000),
    ).resolves.toBe(true);
    expect(processor.getDropStats().shutdown_timeout).toBe(1);

    resolveStream?.(REPLACEMENT);
    await vi.waitUntil(() => finalized.includes(REPLACEMENT));
    expect(calls.map((call) => call.writeStream)).toEqual([STREAM]);
  });
});
