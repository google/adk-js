/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '@google/adk';
import * as http from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

const TEST_AGENT = new LlmAgent({name: 'testAgent', description: 'test agent'});

const AGENT_LOADER = {
  listAgents: () => Promise.resolve(['testApp']),
  getAgentFile: () =>
    Promise.resolve({
      load: () => Promise.resolve(TEST_AGENT),
      async [Symbol.asyncDispose](): Promise<void> {
        return;
      },
    }),
} as unknown as AgentLoader;

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Issues a request with `node:http` rather than `fetch`, because undici
 * silently drops a caller-supplied `Host` header.
 */
function request(
  port: number,
  path: string,
  options: {method?: string; headers?: http.OutgoingHttpHeaders} = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({status: res.statusCode ?? 0, headers: res.headers, body}),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('AdkApiServer origin validation', () => {
  let server: AdkApiServer;

  async function startServer(
    options: {allowOrigins?: string} = {},
  ): Promise<number> {
    server = new AdkApiServer({agentLoader: AGENT_LOADER, ...options});
    await server.start();
    return Number(new URL(server.url).port);
  }

  afterEach(async () => {
    await server.stop();
  });

  it('rejects a state-changing request from a foreign origin', async () => {
    const port = await startServer();

    const response = await request(port, '/apps/testApp/users/u/sessions', {
      method: 'POST',
      headers: {origin: 'http://evil.com'},
    });

    expect(response.status).toBe(403);
    expect(response.body).toBe('Forbidden: origin not allowed');
  });

  it('allows a state-changing request from its own origin', async () => {
    const port = await startServer();

    const response = await request(port, '/apps/testApp/users/u/sessions', {
      method: 'POST',
      headers: {origin: `http://localhost:${port}`},
    });

    expect(response.status).toBe(200);
  });

  it.each([
    ['http://evil.com', 'http://evil.com'],
    ['*', '*'],
    // A comma-separated list used to reach `cors` as one unmatchable string.
    ['http://other.example, http://evil.com', 'http://evil.com'],
  ])(
    'lets a configured origin through and echoes the CORS header for %s',
    async (allowOrigins, expected) => {
      const port = await startServer({allowOrigins});

      const response = await request(port, '/apps/testApp/users/u/sessions', {
        method: 'POST',
        headers: {origin: 'http://evil.com'},
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(expected);
    },
  );

  it('sends CORS headers on routes declared before the middleware, like /version', async () => {
    const port = await startServer({allowOrigins: 'http://localhost:4200'});

    const response = await request(port, '/version', {
      headers: {origin: 'http://localhost:4200'},
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
  });
});
