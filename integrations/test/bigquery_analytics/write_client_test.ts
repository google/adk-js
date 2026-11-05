/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type TableField} from '@google-cloud/bigquery';
import {adapt, type managedwriter} from '@google-cloud/bigquery-storage';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  AppendAbortedError,
  closeWriteClient,
  createStorageRowAppender,
  GRPC_CODE,
  MAX_RETIRED_CONNECTIONS,
  MAX_STANDBY_CONNECTIONS,
  RowEncodingError,
  WRITER_TRACE_ID,
} from '../../src/bigquery_analytics/write_client.js';
import {
  type AppendRowsRequest,
  fakeClient,
  nextTurn,
  pendingRequests,
  retainedConnections,
} from './fake_writer_client.js';

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

function append(
  appender: ReturnType<typeof createStorageRowAppender>,
  signal?: AbortSignal,
  writeStream = STREAM,
) {
  return appender.appendRows({
    writeStream,
    rows: [{timestamp: new Date(0)}],
    offset: null,
    traceId: WRITER_TRACE_ID,
    signal,
  });
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

describe('createStorageRowAppender connection lifecycle', () => {
  it('returns null when the stream ends without a status, then reconnects', async () => {
    const {client, connections} = fakeClient(
      {appendResult: {}},
      (duplex, index) => {
        // A falsy response settles the pending write without a status.
        duplex.push(index === 1 ? 0 : {appendResult: {}});
      },
    );
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    await expect(append(appender)).resolves.toBeNull();
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(connections).toHaveLength(2);
    expect(connections[0]?.destroyed).toBe(true);
    appender.close();
  });

  it('evicts a connection whose append failed in transport', async () => {
    const {client, connections} = fakeClient(
      {appendResult: {}},
      (duplex, index) => {
        if (index === 1) {
          duplex.emit('error', Object.assign(new Error('broken'), {code: 3}));
          return;
        }
        duplex.push({appendResult: {}});
      },
    );
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    await expect(append(appender)).rejects.toThrow('broken');
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(connections).toHaveLength(2);
    appender.close();
  });

  it('sends nothing once the signal has aborted', async () => {
    const {client, requests} = fakeClient({appendResult: {}});
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const controller = new AbortController();
    const pending = append(appender, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AppendAbortedError);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(requests).toEqual([]);
    appender.close();
  });

  it('abandons and evicts a connection when aborted while awaiting a response', async () => {
    const {client, connections} = fakeClient(
      {appendResult: {}},
      (duplex, index) => {
        if (index > 1) {
          duplex.push({appendResult: {}});
        }
      },
    );
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const controller = new AbortController();
    const pending = append(appender, controller.signal);
    await vi.waitUntil(() => connections.length === 1);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AppendAbortedError);
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(connections).toHaveLength(2);
    appender.close();
  });

  it('closes the cached connection before finalizing the stream', async () => {
    const {client, connections, finalizeWriteStream} = fakeClient({
      appendResult: {},
    });
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    await append(appender);
    await appender.finalizeWriteStream({name: STREAM});
    expect(finalizeWriteStream).toHaveBeenCalledWith({name: STREAM});
    await vi.waitUntil(() => connections[0]?.destroyed === true);
    appender.close();
  });

  it('close closes every connection, and a later append reconnects', async () => {
    const {client, connections} = fakeClient({appendResult: {}});
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    await append(appender);
    appender.close();
    await vi.waitUntil(() => connections[0]?.destroyed === true);
    await append(appender);
    expect(connections).toHaveLength(2);
    appender.close();
  });
});

describe('createStorageRowAppender connection reuse', () => {
  it('evicts an acquisition aborted while connecting, and closes the late writer', async () => {
    const {client, connections} = fakeClient({appendResult: {}});
    const create = client.createStreamConnection.bind(client);
    let releaseFirst: (() => void) | undefined;
    const factory = vi
      .spyOn(client, 'createStreamConnection')
      .mockImplementationOnce(async (request) => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return create(request);
      });
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const controller = new AbortController();
    const first = append(appender, controller.signal);
    await vi.waitUntil(() => releaseFirst !== undefined);
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(AppendAbortedError);

    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(factory).toHaveBeenCalledTimes(2);

    releaseFirst?.();
    await vi.waitUntil(() => connections.length === 2);
    await vi.waitUntil(() => connections[1]?.destroyed === true);
    expect(connections[0]?.destroyed).toBe(false);
    appender.close();
  });

  it('keeps one SDK connection across idle closes and transport failures', async () => {
    const {client, connections} = fakeClient(
      {appendResult: {}},
      (duplex, index) => {
        if (index % 2 === 0) {
          duplex.emit('error', Object.assign(new Error('broken'), {code: 14}));
          return;
        }
        duplex.push({appendResult: {}});
      },
    );
    const factory = vi.spyOn(client, 'createStreamConnection');
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    for (let cycle = 0; cycle < 5; cycle++) {
      await expect(append(appender)).resolves.toMatchObject({error: null});
      await expect(append(appender)).rejects.toThrow('broken');
      appender.close();
    }
    expect(factory).toHaveBeenCalledOnce();
    expect(retainedConnections(client)).toHaveLength(1);
    await vi.waitUntil(() => connections.every((duplex) => duplex.destroyed));
  });

  it('opens a new SDK connection after an abandoned request, and after finalization', async () => {
    const {client} = fakeClient({appendResult: {}}, (duplex, index) => {
      if (index > 1) {
        duplex.push({appendResult: {}});
      }
    });
    const factory = vi.spyOn(client, 'createStreamConnection');
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const controller = new AbortController();
    const abandoned = append(appender, controller.signal);
    await vi.waitUntil(() => factory.mock.calls.length === 1);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    controller.abort();
    await expect(abandoned).rejects.toBeInstanceOf(AppendAbortedError);
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(factory).toHaveBeenCalledTimes(2);

    await appender.finalizeWriteStream({name: STREAM});
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(factory).toHaveBeenCalledTimes(3);
    appender.close();
  });
});

describe('createStorageRowAppender in-band errors the SDK raises', () => {
  it.each([
    GRPC_CODE.CANCELLED,
    GRPC_CODE.DEADLINE_EXCEEDED,
    GRPC_CODE.ABORTED,
    GRPC_CODE.INTERNAL,
    GRPC_CODE.UNAVAILABLE,
  ])(
    'returns in-band code %i as an outcome and keeps the connection',
    async (code) => {
      const {client, connections} = fakeClient(
        {appendResult: {}},
        (duplex, index) => {
          duplex.push(
            index === 1
              ? {error: {code, message: 'transient'}}
              : {appendResult: {}},
          );
        },
      );
      const factory = vi.spyOn(client, 'createStreamConnection');
      const appender = createStorageRowAppender({client, schema: SCHEMA});
      await expect(append(appender)).resolves.toEqual({
        error: {code, message: 'transient'},
        rowErrors: null,
      });
      await expect(append(appender)).resolves.toMatchObject({error: null});
      expect(factory).toHaveBeenCalledOnce();
      expect(connections).toHaveLength(1);
      expect(connections[0]?.destroyed).toBe(false);
      appender.close();
    },
  );

  it('keeps a transport error raised even when its code is an in-band one', async () => {
    const {client} = fakeClient({appendResult: {}}, (duplex) => {
      duplex.emit(
        'error',
        Object.assign(new Error('deadline'), {
          code: GRPC_CODE.DEADLINE_EXCEEDED,
        }),
      );
    });
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    await expect(append(appender)).rejects.toMatchObject({
      code: GRPC_CODE.DEADLINE_EXCEEDED,
      message: 'deadline',
    });
    appender.close();
  });

  it('keeps the rejection raised when the connection closes under a request', async () => {
    const {client} = fakeClient({appendResult: {}}, (duplex) => {
      duplex.destroy();
    });
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    await expect(append(appender)).rejects.toMatchObject({
      code: GRPC_CODE.UNAVAILABLE,
    });
    appender.close();
  });
});

describe('createStorageRowAppender retired connections', () => {
  /** A client that answers only while `answering` is set. */
  function quietClient() {
    const state = {answering: false};
    const fake = fakeClient({appendResult: {}}, (duplex) => {
      if (state.answering) {
        duplex.push({appendResult: {}});
      }
    });
    return {...fake, state};
  }

  async function abandonInFlight(
    appender: ReturnType<typeof createStorageRowAppender>,
    requests: ReadonlyArray<unknown>,
  ): Promise<void> {
    const controller = new AbortController();
    const sent = requests.length;
    const pending = append(appender, controller.signal);
    await vi.waitUntil(() => requests.length > sent);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AppendAbortedError);
    await nextTurn();
  }

  /**
   * Aborts `count` appends in a row while their connection is still being
   * acquired, then lets every acquisition finish.
   */
  async function abandonAcquisitions(
    client: managedwriter.WriterClient,
    appender: ReturnType<typeof createStorageRowAppender>,
    count: number,
  ) {
    const create = client.createStreamConnection.bind(client);
    const releases: Array<() => void> = [];
    let slow = true;
    const factory = vi
      .spyOn(client, 'createStreamConnection')
      .mockImplementation(async (request) => {
        if (slow) {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        }
        return create(request);
      });
    for (let attempt = 1; attempt <= count; attempt++) {
      const controller = new AbortController();
      const pending = append(appender, controller.signal);
      await vi.waitUntil(() => releases.length === attempt);
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(AppendAbortedError);
    }
    slow = false;
    for (const release of releases) {
      release();
    }
    await vi.waitUntil(
      () =>
        retainedConnections(client).length >= count ||
        factory.mock.calls.length > count,
    );
    await nextTurn();
    return factory;
  }

  it('recycles a plugin-owned client so abandoned requests stay bounded', async () => {
    const {client, requests, state} = quietClient();
    const appender = createStorageRowAppender({
      client,
      schema: SCHEMA,
      ownsClient: true,
    });
    for (let cycle = 0; cycle < 3 * MAX_RETIRED_CONNECTIONS; cycle++) {
      await abandonInFlight(appender, requests);
      expect(retainedConnections(client).length).toBeLessThanOrEqual(
        MAX_RETIRED_CONNECTIONS,
      );
      expect(pendingRequests(client)).toBeLessThanOrEqual(
        MAX_RETIRED_CONNECTIONS,
      );
    }
    state.answering = true;
    await expect(append(appender)).resolves.toMatchObject({error: null});
    appender.close();
  });

  it('never closes a supplied client, which keeps the abandoned requests', async () => {
    const {client, requests, state} = quietClient();
    const close = vi.spyOn(client, 'close');
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    for (let cycle = 0; cycle < MAX_RETIRED_CONNECTIONS + 2; cycle++) {
      await abandonInFlight(appender, requests);
    }
    expect(close).not.toHaveBeenCalled();
    expect(retainedConnections(client)).toHaveLength(
      MAX_RETIRED_CONNECTIONS + 2,
    );
    expect(pendingRequests(client)).toBe(MAX_RETIRED_CONNECTIONS + 2);
    state.answering = true;
    await expect(append(appender)).resolves.toMatchObject({error: null});
    appender.close();
  });

  it('reuses late acquisitions and recycles a plugin-owned client past the bound', async () => {
    const count = MAX_RETIRED_CONNECTIONS + MAX_STANDBY_CONNECTIONS + 2;
    const {client, connections} = fakeClient({appendResult: {}});
    const appender = createStorageRowAppender({
      client,
      schema: SCHEMA,
      ownsClient: true,
    });
    const factory = await abandonAcquisitions(client, appender, count);
    await vi.waitUntil(() => connections.every((duplex) => duplex.destroyed));

    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(factory).toHaveBeenCalledTimes(count + 1);
    expect(retainedConnections(client)).toHaveLength(1);
    expect(pendingRequests(client)).toBe(0);
    appender.close();
  });

  it('reuses a late acquisition that arrived while its replacement was active', async () => {
    const {client, requests, state} = quietClient();
    state.answering = true;
    const create = client.createStreamConnection.bind(client);
    let releaseFirst: (() => void) | undefined;
    const factory = vi
      .spyOn(client, 'createStreamConnection')
      .mockImplementationOnce(async (request) => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return create(request);
      });
    const close = vi.spyOn(client, 'close');
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const controller = new AbortController();
    const first = append(appender, controller.signal);
    await vi.waitUntil(() => releaseFirst !== undefined);
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(AppendAbortedError);
    await expect(append(appender)).resolves.toMatchObject({error: null});
    releaseFirst?.();
    await vi.waitUntil(() => retainedConnections(client).length === 2);
    await nextTurn();

    state.answering = false;
    await abandonInFlight(appender, requests);
    state.answering = true;
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(factory).toHaveBeenCalledTimes(2);
    expect(retainedConnections(client)).toHaveLength(2);
    expect(close).not.toHaveBeenCalled();
    appender.close();
  });

  /**
   * On distinct committed streams, aborts an append while its connection is
   * still being acquired, then finalizes the stream and lets the acquisition
   * finish, in either order.
   */
  async function lateAcquisitionsAcrossFinalizedStreams(
    finalizeFirst: boolean,
  ) {
    const streams = MAX_RETIRED_CONNECTIONS + MAX_STANDBY_CONNECTIONS + 4;
    const {client, state} = quietClient();
    state.answering = true;
    const create = client.createStreamConnection.bind(client);
    const releases: Array<() => void> = [];
    let arrived = 0;
    let slow = true;
    vi.spyOn(client, 'createStreamConnection').mockImplementation(
      async (request) => {
        if (slow) {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        }
        const connection = await create(request);
        arrived += 1;
        return connection;
      },
    );
    const close = vi.spyOn(client, 'close');
    const appender = createStorageRowAppender({
      client,
      schema: SCHEMA,
      ownsClient: true,
    });
    for (let index = 0; index < streams; index++) {
      const writeStream = `projects/p/datasets/d/tables/t/streams/s${index}`;
      const controller = new AbortController();
      const pending = append(appender, controller.signal, writeStream);
      await vi.waitUntil(() => releases.length === index + 1);
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(AppendAbortedError);
      if (finalizeFirst) {
        await appender.finalizeWriteStream({name: writeStream});
      }
      releases[index]();
      await vi.waitUntil(() => arrived === index + 1);
      await nextTurn();
      if (!finalizeFirst) {
        await appender.finalizeWriteStream({name: writeStream});
      }
    }
    slow = false;
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(close).toHaveBeenCalled();
    expect(retainedConnections(client).length).toBeLessThanOrEqual(
      MAX_RETIRED_CONNECTIONS + 1,
    );
    expect(pendingRequests(client)).toBe(0);
    appender.close();
  }

  it('retires acquisitions that arrive after their stream was finalized', async () => {
    await lateAcquisitionsAcrossFinalizedStreams(true);
  });

  it('retires acquisitions that arrive before their stream is finalized', async () => {
    await lateAcquisitionsAcrossFinalizedStreams(false);
  });

  it('does not reuse an acquisition that arrives after another stream was finalized', async () => {
    const {client, state} = quietClient();
    state.answering = true;
    const create = client.createStreamConnection.bind(client);
    let releaseFirst: (() => void) | undefined;
    const factory = vi
      .spyOn(client, 'createStreamConnection')
      .mockImplementationOnce(async (request) => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return create(request);
      });
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const controller = new AbortController();
    const first = append(appender, controller.signal);
    await vi.waitUntil(() => releaseFirst !== undefined);
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(AppendAbortedError);
    await appender.finalizeWriteStream({
      name: 'projects/p/datasets/d/tables/t/streams/other',
    });
    releaseFirst?.();
    await vi.waitUntil(() => retainedConnections(client).length === 1);
    await nextTurn();

    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(factory).toHaveBeenCalledTimes(2);
    appender.close();
  });

  /**
   * Aborts `late` appends while their connection is still being acquired,
   * recycles the plugin-owned client with abandoned appends and completes an
   * append on the new client, and only then lets the acquisitions finish.
   */
  async function lateAcquisitionsAfterRecycle(late: number) {
    const {client, requests, state} = quietClient();
    const create = client.createStreamConnection.bind(client);
    const releases: Array<() => void> = [];
    let slow = true;
    const factory = vi
      .spyOn(client, 'createStreamConnection')
      .mockImplementation(async (request) => {
        if (slow) {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        }
        return create(request);
      });
    const close = vi.spyOn(client, 'close');
    const appender = createStorageRowAppender({
      client,
      schema: SCHEMA,
      ownsClient: true,
    });
    for (let attempt = 1; attempt <= late; attempt++) {
      const controller = new AbortController();
      const pending = append(appender, controller.signal);
      await vi.waitUntil(() => releases.length === attempt);
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(AppendAbortedError);
    }
    slow = false;
    for (let cycle = 0; cycle < MAX_RETIRED_CONNECTIONS; cycle++) {
      await abandonInFlight(appender, requests);
    }
    state.answering = true;
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(close).toHaveBeenCalledOnce();
    expect(retainedConnections(client)).toHaveLength(1);

    for (const release of releases) {
      release();
    }
    await vi.waitUntil(() => retainedConnections(client).length === late + 1);
    await nextTurn();
    return {client, requests, state, factory, close, appender};
  }

  it('reuses an acquisition that arrives after a client recycle', async () => {
    const {client, requests, state, factory, appender} =
      await lateAcquisitionsAfterRecycle(1);
    const calls = factory.mock.calls.length;

    state.answering = false;
    await abandonInFlight(appender, requests);
    state.answering = true;
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(factory).toHaveBeenCalledTimes(calls);
    expect(retainedConnections(client)).toHaveLength(2);
    expect(pendingRequests(client)).toBe(1);
    appender.close();
  });

  it('counts acquisitions that arrive after a client recycle toward the next one', async () => {
    const late = MAX_RETIRED_CONNECTIONS + MAX_STANDBY_CONNECTIONS;
    const {client, close, appender} = await lateAcquisitionsAfterRecycle(late);

    appender.close();
    await expect(append(appender)).resolves.toMatchObject({error: null});
    expect(close).toHaveBeenCalledTimes(2);
    expect(retainedConnections(client)).toHaveLength(1);
    expect(pendingRequests(client)).toBe(0);
    appender.close();
  });
});

describe('createStorageRowAppender schema updates', () => {
  function storageSchema(extra: ReadonlyArray<string>) {
    return adapt.convertBigQuerySchemaToStorageTableSchema({
      fields: [
        ...SCHEMA,
        ...extra.map((name) => ({name, type: 'STRING', mode: 'NULLABLE'})),
      ],
    });
  }

  function fieldNames(request: AppendRowsRequest | undefined): Array<string> {
    return (request?.protoRows?.writerSchema?.protoDescriptor?.field ?? []).map(
      (field) => field.name ?? '',
    );
  }

  it('applies schema updates after an idle close and after a transport-failure reopen', async () => {
    const updates = new Map<number, Array<string>>([
      [1, ['extra1']],
      [3, ['extra1', 'extra2']],
      [6, ['extra1', 'extra2', 'extra3']],
    ]);
    const {client, requests} = fakeClient(
      {appendResult: {}},
      (duplex, index) => {
        if (index === 5) {
          duplex.emit(
            'error',
            Object.assign(new Error('broken'), {code: GRPC_CODE.UNAVAILABLE}),
          );
          return;
        }
        const extra = updates.get(index);
        duplex.push(
          extra
            ? {appendResult: {}, updatedSchema: storageSchema(extra)}
            : {appendResult: {}},
        );
      },
    );
    const factory = vi.spyOn(client, 'createStreamConnection');
    const appender = createStorageRowAppender({client, schema: SCHEMA});
    const schemaListeners = () =>
      retainedConnections(client).map((connection) =>
        connection.listenerCount('schemaUpdated'),
      );

    await append(appender);
    await append(appender);
    expect(fieldNames(requests[1])).toContain('extra1');

    appender.close();
    await append(appender);
    expect(fieldNames(requests[2])).toContain('extra1');
    expect(schemaListeners()).toEqual([2]);
    await append(appender);
    expect(fieldNames(requests[3])).toContain('extra2');

    await expect(append(appender)).rejects.toThrow('broken');
    await append(appender);
    expect(fieldNames(requests[5])).toContain('extra2');
    expect(schemaListeners()).toEqual([2]);
    await append(appender);
    expect(fieldNames(requests[6])).toContain('extra3');

    expect(factory).toHaveBeenCalledOnce();
    expect(schemaListeners()).toEqual([2]);
    appender.close();
    expect(schemaListeners()).toEqual([0]);
  });

  it.each(['idle-close', 'transport-failure'])(
    'keeps a schema update carried by an in-band error after a reopen (%s)',
    async (reopen) => {
      const {client, requests} = fakeClient(
        {appendResult: {}},
        (duplex, index) => {
          if (index === 1) {
            duplex.push({
              error: {code: GRPC_CODE.DEADLINE_EXCEEDED, message: 'deadline'},
              updatedSchema: storageSchema(['added']),
            });
          } else if (index === 3 && reopen === 'transport-failure') {
            duplex.emit(
              'error',
              Object.assign(new Error('broken'), {
                code: GRPC_CODE.UNAVAILABLE,
              }),
            );
          } else {
            duplex.push({appendResult: {}});
          }
        },
      );
      const appender = createStorageRowAppender({client, schema: SCHEMA});
      const schemaListeners = () =>
        retainedConnections(client).map((connection) =>
          connection.listenerCount('schemaUpdated'),
        );

      await expect(append(appender)).resolves.toMatchObject({
        error: {code: GRPC_CODE.DEADLINE_EXCEEDED},
      });
      await expect(append(appender)).resolves.toMatchObject({error: null});
      expect(fieldNames(requests[1])).toContain('added');
      expect(schemaListeners()).toEqual([2]);

      if (reopen === 'idle-close') {
        appender.close();
      } else {
        await expect(append(appender)).rejects.toThrow('broken');
      }
      expect(schemaListeners()).toEqual([0]);
      await expect(append(appender)).resolves.toMatchObject({error: null});
      expect(fieldNames(requests.at(-1))).toContain('added');
      expect(schemaListeners()).toEqual([2]);
      appender.close();
      expect(schemaListeners()).toEqual([0]);
    },
  );
});

describe('closeWriteClient', () => {
  function writerClient(transportClose: () => Promise<void>) {
    const close = vi.fn();
    const client = {
      close,
      getClient: () => ({close: transportClose}),
    } as unknown as managedwriter.WriterClient;
    return {client, close};
  }

  it('resolves after the timeout when the transport never closes', async () => {
    const {client, close} = writerClient(
      () => new Promise<void>(() => undefined),
    );
    await expect(
      closeWriteClient({client, timeoutSeconds: 0.01}),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects when the transport fails to close', async () => {
    const {client} = writerClient(() => Promise.reject(new Error('stuck')));
    await expect(closeWriteClient({client})).rejects.toThrow('stuck');
  });
});
