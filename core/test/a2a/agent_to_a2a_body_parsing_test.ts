/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {toA2a} from '../../src/a2a/agent_to_a2a.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {logger} from '../../src/utils/logger.js';

// Bodies the A2A handlers saw, newest last; filled by the mock below.
const {receivedBodies} = vi.hoisted(() => ({receivedBodies: [] as unknown[]}));

// Express itself is deliberately NOT mocked: this file exercises the real
// middleware stack that `toA2a` installs, over a real loopback socket.
vi.mock('@a2a-js/sdk/server/express', () => {
  const recordBody: express.RequestHandler = (req, res) => {
    receivedBodies.push(req.body);
    res.status(204).end();
  };
  return {
    agentCardHandler: () => recordBody,
    restHandler: () => recordBody,
    jsonRpcHandler: () => recordBody,
    UserBuilder: {noAuthentication: 'noAuthentication'},
  };
});

vi.mock('@a2a-js/sdk/server', () => ({
  DefaultRequestHandler: vi.fn().mockImplementation(() => ({})),
  InMemoryTaskStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/a2a/agent_executor.js', () => ({
  A2AAgentExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/a2a/agent_card.js', () => ({
  getA2AAgentCard: vi.fn().mockResolvedValue({name: 'mocked_card'}),
  resolveAgentCard: vi.fn().mockResolvedValue({name: 'resolved_card'}),
}));

class TestAgent extends BaseAgent {
  constructor() {
    super({name: 'test-agent'});
  }
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

describe('toA2a body parsing', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    receivedBodies.length = 0;
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const app = await toA2a(new TestAgent(), {allowUnauthenticated: true});
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // `fetch` keeps the socket alive, which would stall `close()`.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function post(path: string, contentType: string, body: string) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {'content-type': contentType},
      body,
    });
  }

  // `a[b][0][c]=d` is the crux of the bug: `qs` rebuilds it as
  // `{a: {b: [{c: 'd'}]}}`, so a form body — a CORS-safelisted content type
  // that needs no preflight — could carry a fully structured JSON-RPC request.
  it('does not parse a form-encoded body', async () => {
    await post('/rest', 'application/x-www-form-urlencoded', 'a[b][0][c]=d');

    expect(receivedBodies[0]).toEqual({});
  });

  it('still parses a JSON body', async () => {
    const payload = {jsonrpc: '2.0', id: 1, method: 'message/send'};

    await post('/rest', 'application/json', JSON.stringify(payload));

    expect(receivedBodies[0]).toEqual(payload);
  });
});
