/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {VertexAiSessionService} from '@google/adk';
import {
  ApiClient,
  Auth,
  NodeDownloader,
  NodeUploader,
} from '@google/genai/vertex_internal';
import {createServer, IncomingMessage, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const REASONING_ENGINE_ID = '12345';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * There is no identity to assert against a loopback server, so requests go out
 * unauthenticated. Everything else - the SDK converters, the request body
 * serialization and the HTTP round trip - is the real implementation.
 */
const unauthenticated: Auth = {
  async addAuthHeaders(): Promise<void> {},
};

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<
    string,
    unknown
  >;
}

describe('VertexAiSessionService session expiration over the wire', () => {
  let server: Server;
  let service: VertexAiSessionService;
  let requests: CapturedRequest[];

  beforeAll(async () => {
    server = createServer((request, response) => {
      void readJsonBody(request).then((body) => {
        requests.push({url: request.url!, body});
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(
          JSON.stringify({
            name: `operations/${requests.length}`,
            done: true,
            response: {
              name: `reasoningEngines/${REASONING_ENGINE_ID}/sessions/session-1`,
              updateTime: '2026-01-01T00:00:00Z',
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const apiClient = new ApiClient({
      auth: unauthenticated,
      uploader: new NodeUploader(),
      downloader: new NodeDownloader(),
      project: 'test-project',
      location: 'us-central1',
      vertexai: true,
      httpOptions: {
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
    });
    service = new VertexAiSessionService({
      agentEngineId: REASONING_ENGINE_ID,
      sessions: new Sessions(apiClient),
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    requests = [];
  });

  it('sends ttl in the create request body', async () => {
    const session = await service.createSession({
      appName: REASONING_ENGINE_ID,
      userId: 'user-1',
      ttl: '7200s',
    });

    expect(session.id).toBe('session-1');
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({userId: 'user-1', ttl: '7200s'});
  });

  it('sends expireTime in the create request body', async () => {
    await service.createSession({
      appName: REASONING_ENGINE_ID,
      userId: 'user-1',
      expireTime: '2026-10-01T00:00:00Z',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      userId: 'user-1',
      expireTime: '2026-10-01T00:00:00Z',
    });
  });

  it('sends no expiration fields when none are requested', async () => {
    await service.createSession({
      appName: REASONING_ENGINE_ID,
      userId: 'user-1',
      state: {foo: 'bar'},
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      userId: 'user-1',
      sessionState: {foo: 'bar'},
    });
  });

  it('issues no request when ttl and expireTime are both set', async () => {
    await expect(
      service.createSession({
        appName: REASONING_ENGINE_ID,
        userId: 'user-1',
        ttl: '7200s',
        expireTime: '2026-10-01T00:00:00Z',
      }),
    ).rejects.toThrow(
      "Cannot specify both 'ttl' and 'expireTime' simultaneously.",
    );
    expect(requests).toHaveLength(0);
  });
});
