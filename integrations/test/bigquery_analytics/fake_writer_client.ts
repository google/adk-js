/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {managedwriter, type protos} from '@google-cloud/bigquery-storage';
import {Duplex} from 'node:stream';
import {vi} from 'vitest';

export type AppendRowsRequest =
  protos.google.cloud.bigquery.storage.v1.IAppendRowsRequest;
export type AppendRowsResponse =
  protos.google.cloud.bigquery.storage.v1.IAppendRowsResponse;

/**
 * A real `managedwriter.WriterClient` whose AppendRows streams are in-memory
 * duplexes; `respond` answers each request on the stream that received it.
 */
export function fakeClient(
  response: AppendRowsResponse,
  respond: (duplex: Duplex, index: number) => void = (duplex) => {
    duplex.push(response);
  },
) {
  const client = new managedwriter.WriterClient({projectId: 'p'});
  const requests: Array<AppendRowsRequest> = [];
  const connections: Array<Duplex> = [];
  vi.spyOn(client, 'initialize').mockResolvedValue();
  const finalizeWriteStream = vi
    .spyOn(client, 'finalizeWriteStream')
    .mockResolvedValue({});
  vi.spyOn(client.getClient(), 'appendRows').mockImplementation(() => {
    const duplex = new Duplex({
      objectMode: true,
      read: () => undefined,
      write(chunk: AppendRowsRequest, _encoding, callback) {
        requests.push(chunk);
        callback();
        respond(this, requests.length);
      },
    });
    connections.push(duplex);
    return Object.assign(duplex, {cancel: () => undefined});
  });
  return {client, requests, connections, finalizeWriteStream};
}

type StreamConnection = Awaited<
  ReturnType<managedwriter.WriterClient['createStreamConnection']>
>;

/** The SDK connections a client still holds; private SDK state. */
export function retainedConnections(
  client: managedwriter.WriterClient,
): Array<StreamConnection> {
  return (
    client as unknown as {
      _connections: {connectionList: Array<StreamConnection>};
    }
  )._connections.connectionList;
}

/** Requests left pending on the connections a client still holds. */
export function pendingRequests(client: managedwriter.WriterClient): number {
  return retainedConnections(client).reduce(
    (total, connection) => total + connection.getPendingWrites().length,
    0,
  );
}

export function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
