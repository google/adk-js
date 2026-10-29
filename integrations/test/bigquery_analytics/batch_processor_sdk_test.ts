/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type TableField} from '@google-cloud/bigquery';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BatchProcessor} from '../../src/bigquery_analytics/batch_processor.js';
import {type EventRow} from '../../src/bigquery_analytics/types.js';
import {GRPC_CODE} from '../../src/bigquery_analytics/write_client.js';
import {fakeClient} from './fake_writer_client.js';

const TABLE = 'projects/p/datasets/d/tables/t';
const COMMITTED = `${TABLE}/streams/committed-1`;

const SCHEMA: Array<TableField> = [
  {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
  {name: 'event_id', type: 'STRING', mode: 'NULLABLE'},
  {name: 'event_type', type: 'STRING', mode: 'NULLABLE'},
];

function row(eventId: string): EventRow {
  return {
    timestamp: new Date('2026-10-23T10:00:00.000Z'),
    event_id: eventId,
    event_type: 'LLM_REQUEST',
  } as EventRow;
}

function nonZero(stats: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(stats).filter(([, count]) => count > 0),
  );
}

/**
 * `BatchProcessor` over the real `createStorageRowAppender`, `WriterClient`,
 * `StreamConnection` and `JSONWriter`; only the gRPC duplex is in memory.
 * The first request is answered with an in-band `firstError`.
 */
function sdkProcessor({
  firstError,
  exactlyOnceDelivery = false,
}: {
  firstError: {code: number; message: string};
  exactlyOnceDelivery?: boolean;
}) {
  const fake = fakeClient({appendResult: {}}, (duplex, index) => {
    duplex.push(index === 1 ? {error: firstError} : {appendResult: {}});
  });
  const processor = new BatchProcessor({
    writeClient: fake.client,
    schema: SCHEMA,
    destinationTable: TABLE,
    ...(exactlyOnceDelivery ? {writeStream: COMMITTED} : {}),
    batchSize: 1,
    flushInterval: 1,
    retryConfig: {maxRetries: 2, initialDelay: 0, multiplier: 1, maxDelay: 0},
    queueMaxSize: 10,
    shutdownTimeout: 1,
    exactlyOnceDelivery,
  });
  processor.start();
  return {...fake, processor};
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BatchProcessor over the managedwriter SDK', () => {
  it.each([
    GRPC_CODE.DEADLINE_EXCEEDED,
    GRPC_CODE.INTERNAL,
    GRPC_CODE.UNAVAILABLE,
  ])(
    'retries an in-band code %i the SDK raises, then writes the batch',
    async (code) => {
      const {processor, requests} = sdkProcessor({
        firstError: {code, message: 'transient deadline'},
      });
      processor.append(row('e1'));
      await processor.flush();
      expect(requests).toHaveLength(2);
      expect(nonZero(processor.getDropStats())).toEqual({});
      await processor.shutdown();
    },
  );

  it('retries an in-band DEADLINE_EXCEEDED at the same offset without desyncing the committed stream', async () => {
    const {processor, requests} = sdkProcessor({
      firstError: {
        code: GRPC_CODE.DEADLINE_EXCEEDED,
        message: 'transient deadline',
      },
      exactlyOnceDelivery: true,
    });
    processor.append(row('e1'));
    await processor.flush();
    processor.append(row('e2'));
    await processor.flush();
    expect(requests.map((request) => Number(request.offset?.value))).toEqual([
      0, 0, 1,
    ]);
    expect(requests.every((request) => request.writeStream === COMMITTED)).toBe(
      true,
    );
    expect(nonZero(processor.getDropStats())).toEqual({});
    await processor.shutdown();
  });

  it('drops an in-band ABORTED the SDK raises as non-retryable, like the reference', async () => {
    const {processor, requests} = sdkProcessor({
      firstError: {code: GRPC_CODE.ABORTED, message: 'aborted'},
    });
    processor.append(row('e1'));
    await processor.flush();
    expect(requests).toHaveLength(1);
    expect(nonZero(processor.getDropStats())).toEqual({non_retryable: 1});
    await processor.shutdown();
  });
});
