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
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {json} from 'node:stream/consumers';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const REASONING_ENGINE_ID = '12345';

/**
 * There is no identity to assert against a loopback server, so requests go out
 * unauthenticated. Everything else - the SDK converters, the request body
 * serialization and the HTTP round trip - is the real implementation.
 */
const unauthenticated: Auth = {
  async addAuthHeaders(): Promise<void> {},
};

/**
 * Exercises createSession against a loopback HTTP server through the real
 * Agent Engine Sessions client, so the assertions are on the bytes actually
 * sent.
 *
 * createSession builds its config with conditional spreads, and TypeScript
 * does not excess-property-check spread members, so a field name that the SDK
 * does not forward compiles and passes the mocked unit tests. These cases pin
 * the request body itself, and fail if an SDK upgrade stops serializing it.
 */
describe('VertexAiSessionService session expiration over the wire', () => {
  let server: Server;
  let service: VertexAiSessionService;
  let bodies: unknown[];

  beforeAll(async () => {
    server = createServer((request, response) => {
      // An unparseable body is recorded as such and still answered, so a
      // surprise request fails an assertion instead of hanging the suite.
      void json(request)
        .catch(() => 'unparseable request body')
        .then((body) => {
          bodies.push(body);
          response.writeHead(200, {'content-type': 'application/json'});
          response.end(
            JSON.stringify({
              name: 'operations/1',
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
    bodies = [];
  });

  it('sends ttl in the create request body', async () => {
    const session = await service.createSession({
      appName: REASONING_ENGINE_ID,
      userId: 'user-1',
      ttl: '7200s',
    });

    expect(session.id).toBe('session-1');
    expect(bodies).toEqual([{userId: 'user-1', ttl: '7200s'}]);
  });

  it('sends expireTime in the create request body', async () => {
    await service.createSession({
      appName: REASONING_ENGINE_ID,
      userId: 'user-1',
      expireTime: '2026-10-01T00:00:00Z',
    });

    expect(bodies).toEqual([
      {userId: 'user-1', expireTime: '2026-10-01T00:00:00Z'},
    ]);
  });
});
