/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import * as http from 'http';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {toA2a} from '../../src/a2a/agent_to_a2a.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {logger} from '../../src/utils/logger.js';

/**
 * Bodies observed by the A2A handlers, newest last. Populated by the
 * `@a2a-js/sdk/server/express` mock below, which stands in for the real A2A
 * handlers with middleware that only records what Express handed it.
 */
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

/** A nested `qs` payload: parsed, it would become `{a: {b: [{c: 'd'}]}}`. */
const NESTED_FORM_BODY = 'a[b][0][c]=d';

function post(
  port: number,
  path: string,
  contentType: string,
  body: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': contentType,
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on('end', resolve);
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

describe('toA2a body parsing', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    receivedBodies.length = 0;
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const app = await toA2a(new TestAgent(), {allowUnauthenticated: true});
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail('server did not bind to a TCP port');
    }
    port = address.port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it.each(['/rest', '/jsonrpc'])(
    'does not parse a form-encoded body posted to %s',
    async (path) => {
      await post(
        port,
        path,
        'application/x-www-form-urlencoded',
        NESTED_FORM_BODY,
      );

      // body-parser leaves `req.body` as `{}` (express 4) or `undefined`
      // (express 5) for a request it declines to parse; either is fine as long
      // as nothing from the form was reconstructed.
      const body = receivedBodies[0];
      expect(body ?? {}).toEqual({});
      expect(body).not.toHaveProperty('a');
    },
  );

  it('still parses a JSON body', async () => {
    const payload = {jsonrpc: '2.0', id: 1, method: 'message/send'};

    await post(port, '/rest', 'application/json', JSON.stringify(payload));

    expect(receivedBodies[0]).toEqual(payload);
  });
});
