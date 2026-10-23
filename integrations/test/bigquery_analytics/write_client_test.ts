/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type TableField} from '@google-cloud/bigquery';
import {managedwriter, type protos} from '@google-cloud/bigquery-storage';
import {Duplex} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createStorageRowAppender,
  RowEncodingError,
  WRITER_TRACE_ID,
} from '../../src/bigquery_analytics/write_client.js';

const STREAM = 'projects/p/datasets/d/tables/t/streams/_default';

const SCHEMA: Array<TableField> = [
  {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
  {name: 'content', type: 'JSON', mode: 'NULLABLE'},
  {
    name: 'content_parts',
    type: 'RECORD',
    mode: 'REPEATED',
    fields: [
      {name: 'text', type: 'STRING', mode: 'NULLABLE'},
      {
        name: 'object_ref',
        type: 'RECORD',
        mode: 'NULLABLE',
        fields: [{name: 'details', type: 'JSON', mode: 'NULLABLE'}],
      },
    ],
  },
  {name: 'is_truncated', type: 'BOOLEAN', mode: 'NULLABLE'},
];

function varint(value: bigint): Array<number> {
  const bytes: Array<number> = [];
  let rest = value;
  while (rest >= 0x80n) {
    bytes.push(Number((rest & 0x7fn) | 0x80n));
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return bytes;
}

type AppendRowsRequest =
  protos.google.cloud.bigquery.storage.v1.IAppendRowsRequest;
type AppendRowsResponse =
  protos.google.cloud.bigquery.storage.v1.IAppendRowsResponse;

/**
 * A WriterClient whose AppendRows stream is an in-memory duplex answering every
 * request.
 */
function fakeClient(response: AppendRowsResponse) {
  const client = new managedwriter.WriterClient({projectId: 'p'});
  const requests: Array<AppendRowsRequest> = [];
  vi.spyOn(client, 'initialize').mockResolvedValue();
  vi.spyOn(client.getClient(), 'appendRows').mockImplementation(() => {
    const duplex = new Duplex({
      objectMode: true,
      read: () => undefined,
      write(chunk: AppendRowsRequest, _encoding, callback) {
        requests.push(chunk);
        callback();
        this.push(response);
      },
    });
    return Object.assign(duplex, {cancel: () => undefined});
  });
  return {client, requests};
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStorageRowAppender', () => {
  it('encodes TIMESTAMP as epoch microseconds and JSON columns as their text, with offset and trace id', async () => {
    const {client, requests} = fakeClient({appendResult: {}});
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const timestamp = new Date('2026-10-23T10:00:00.000Z');

    const outcome = await appender.appendRows({
      writeStream: STREAM,
      rows: [
        {
          timestamp,
          content: '{"prompt":"hi"}',
          content_parts: [{text: 'part', object_ref: {details: '{"k":1}'}}],
          is_truncated: true,
        },
      ],
      offset: 7,
      traceId: WRITER_TRACE_ID,
    });

    expect(outcome).toEqual({error: null, rowErrors: null});
    const [request] = requests;
    expect(request?.writeStream).toBe(STREAM);
    expect(request?.traceId).toContain(WRITER_TRACE_ID);
    expect(Number(request?.offset?.value)).toBe(7);
    const [encoded] = request?.protoRows?.rows?.serializedRows ?? [];
    const bytes = Buffer.from(encoded ?? new Uint8Array());
    const text = bytes.toString('latin1');
    expect([
      ...bytes.subarray(
        0,
        1 + varint(BigInt(timestamp.getTime()) * 1000n).length,
      ),
    ]).toEqual([0x08, ...varint(BigInt(timestamp.getTime()) * 1000n)]);
    expect(text).toContain('{"prompt":"hi"}');
    expect(text).toContain('{"k":1}');
    expect(text).toContain('part');
    appender.close();
  });

  it('returns the in-band error of a rejected append', async () => {
    const {client} = fakeClient({
      error: {code: 3, message: 'Schema mismatch: field x'},
      rowErrors: [],
    });
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const outcome = await appender.appendRows({
      writeStream: STREAM,
      rows: [{timestamp: new Date(0)}],
      offset: null,
      traceId: WRITER_TRACE_ID,
    });
    expect(outcome?.error).toMatchObject({
      code: 3,
      message: 'Schema mismatch: field x',
    });
    appender.close();
  });

  it('reports rows the schema cannot encode as RowEncodingError before sending', async () => {
    const {client, requests} = fakeClient({appendResult: {}});
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    await expect(
      appender.appendRows({
        writeStream: STREAM,
        rows: [{timestamp: new Date(0), content: {not: 'serialized'}}],
        offset: null,
        traceId: WRITER_TRACE_ID,
      }),
    ).rejects.toBeInstanceOf(RowEncodingError);
    expect(requests).toEqual([]);
    appender.close();
  });
});
