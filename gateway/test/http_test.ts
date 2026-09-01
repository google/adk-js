/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, InMemorySessionService, type Event} from '@google/adk';
import {
  applyFilter,
  createGateway,
  isFinalEvent,
  type Gateway,
  type RouterRequest,
  type RouterResponse,
} from '@google/adk-gateway';
import {memoryChannel} from '@google/adk-gateway/testing/index.js';
import {describe, expect, it, vi} from 'vitest';

import {EchoAgent, FailingAgent} from './echo_agent.js';

// ---------------------------------------------------------------------------
// A minimal HTTP double
// ---------------------------------------------------------------------------

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
  chunks: string[];
}

function request(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): RouterRequest & {fire(event: string): void} {
  const listeners = new Map<string, Array<() => void>>();
  return {
    method,
    url,
    headers,
    body,
    on(event: string, listener: () => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    fire(event: string) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

function response(): RouterResponse & {
  captured: Captured;
  done: Promise<void>;
} {
  const captured: Captured = {status: 0, headers: {}, body: '', chunks: []};
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  return {
    captured,
    done,
    headersSent: false,
    get statusCode() {
      return captured.status;
    },
    set statusCode(value: number) {
      captured.status = value;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(chunk: string) {
      this.headersSent = true;
      captured.chunks.push(chunk);
      return true;
    },
    end(payload?: string) {
      if (payload) {
        captured.body = payload;
      }
      this.headersSent = true;
      finish();
    },
  };
}

/** Sends one request through the middleware and waits for the response. */
async function call(
  gateway: Gateway,
  req: ReturnType<typeof request>,
  options: Parameters<Gateway['endpoints']>[0] = {trustClientUserId: true},
): Promise<Captured> {
  const res = response();
  const next = vi.fn();
  gateway.endpoints(options)(req, res, next);
  if (next.mock.calls.length > 0) {
    return {status: 404, headers: {}, body: '', chunks: []};
  }
  await res.done;
  return res.captured;
}

function json(captured: Captured): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>;
}

/** The `data:` payloads from a server-sent event stream. */
function sseData(captured: Captured): Array<Record<string, unknown>> {
  return captured.chunks
    .filter((chunk) => chunk.startsWith('data: '))
    .map(
      (chunk) => JSON.parse(chunk.slice(6).trim()) as Record<string, unknown>,
    );
}

function newGateway(overrides: Record<string, unknown> = {}): Gateway {
  return createGateway({
    agent: new EchoAgent('web', 'you said:'),
    channels: [memoryChannel()],
    sessionService: new InMemorySessionService(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('endpoints', () => {
  describe('authentication', () => {
    it('refuses to mount without knowing who the caller is', () => {
      // Sessions are keyed by user, so a default of "trust the body" would
      // silently let anyone read anyone else's conversations.
      expect(() => newGateway().endpoints()).toThrow(/resolveUser/);
    });

    it('takes the user from the application, not the request', async () => {
      const gateway = newGateway();
      const captured = await call(
        gateway,
        request('POST', '/sessions', {userId: 'attacker'}),
        {resolveUser: () => 'real-user'},
      );

      const session = await gateway.getSession(
        'real-user',
        json(captured)['sessionId'] as string,
      );
      expect(session).toBeDefined();
      expect(await gateway.getSession('attacker', 'anything')).toBeUndefined();
    });

    it('rejects a caller it cannot identify', async () => {
      const captured = await call(newGateway(), request('POST', '/sessions'), {
        resolveUser: () => undefined,
      });
      expect(captured.status).toBe(401);
    });

    it('allows the body to name the user only when explicitly trusted', async () => {
      const captured = await call(
        newGateway(),
        request('POST', '/sessions', {userId: 'dev'}),
      );
      expect(captured.status).toBe(201);
    });
  });

  describe('sessions', () => {
    it('creates one', async () => {
      const captured = await call(
        newGateway(),
        request('POST', '/sessions', {userId: 'u1'}),
      );

      expect(captured.status).toBe(201);
      expect(json(captured)['sessionId']).toBeTypeOf('string');
    });

    it('adopts a client-chosen id', async () => {
      const captured = await call(
        newGateway(),
        request('POST', '/sessions', {userId: 'u1', sessionId: 'mine'}),
      );
      expect(json(captured)['sessionId']).toBe('mine');
    });

    it('returns the existing one rather than failing on a repeat', async () => {
      const gateway = newGateway();
      const body = {userId: 'u1', sessionId: 'mine'};
      await call(gateway, request('POST', '/sessions', body));
      const second = await call(gateway, request('POST', '/sessions', body));

      expect(second.status).toBe(201);
      expect(json(second)['sessionId']).toBe('mine');
    });

    it('reads back the history', async () => {
      const gateway = newGateway();
      await call(
        gateway,
        request('POST', '/sessions', {userId: 'u1', sessionId: 's'}),
      );
      await call(
        gateway,
        request('POST', '/sessions/s/messages', {userId: 'u1', text: 'hello'}),
      );

      const captured = await call(
        gateway,
        request('GET', '/sessions/s', {userId: 'u1'}),
      );

      const events = json(captured)['events'] as Event[];
      expect(events.length).toBeGreaterThan(0);
    });

    it('404s for a session that is not there', async () => {
      const captured = await call(
        newGateway(),
        request('GET', '/sessions/missing', {userId: 'u1'}),
      );
      expect(captured.status).toBe(404);
    });

    it('deletes one', async () => {
      const gateway = newGateway();
      await call(
        gateway,
        request('POST', '/sessions', {userId: 'u1', sessionId: 's'}),
      );

      const captured = await call(
        gateway,
        request('DELETE', '/sessions/s', {userId: 'u1'}),
      );

      expect(captured.status).toBe(204);
      expect(await gateway.getSession('u1', 's')).toBeUndefined();
    });
  });

  describe('messages', () => {
    it('streams the reply as server-sent events', async () => {
      const captured = await call(
        newGateway(),
        request('POST', '/sessions/s1/messages', {userId: 'u1', text: 'hello'}),
      );

      expect(captured.headers['content-type']).toBe('text/event-stream');
      const texts = sseData(captured).map(
        (event) =>
          (event['content'] as {parts?: Array<{text?: string}>})?.parts?.[0]
            ?.text,
      );
      expect(texts).toContain('you said: hello');
    });

    it('marks the end of the stream', async () => {
      const captured = await call(
        newGateway(),
        request('POST', '/sessions/s1/messages', {userId: 'u1', text: 'hi'}),
      );
      // Without this a client cannot tell a finished turn from a dropped
      // connection.
      expect(captured.chunks.at(-1)).toContain('event: done');
    });

    it('creates the session on first message', async () => {
      // The debug server 404s here, which makes every client write the same
      // create-then-send dance.
      const captured = await call(
        newGateway(),
        request('POST', '/sessions/brand-new/messages', {
          userId: 'u1',
          text: 'hi',
        }),
      );
      expect(sseData(captured).length).toBeGreaterThan(0);
    });

    it('returns one JSON body when asked for it', async () => {
      const captured = await call(
        newGateway(),
        request(
          'POST',
          '/sessions/s1/messages',
          {userId: 'u1', text: 'hello'},
          {accept: 'application/json'},
        ),
      );

      expect(captured.headers['content-type']).toBe('application/json');
      expect((json(captured)['events'] as Event[]).length).toBeGreaterThan(0);
    });

    it('accepts a full content object', async () => {
      const captured = await call(
        newGateway(),
        request('POST', '/sessions/s1/messages', {
          userId: 'u1',
          content: {parts: [{text: 'from parts'}]},
        }),
      );
      expect(JSON.stringify(sseData(captured))).toContain('from parts');
    });

    it('rejects a message with nothing in it', async () => {
      const captured = await call(
        newGateway(),
        request('POST', '/sessions/s1/messages', {userId: 'u1'}),
      );
      expect(captured.status).toBe(400);
    });

    it('reports a failed turn in the stream rather than just hanging up', async () => {
      const captured = await call(
        newGateway({agent: new FailingAgent()}),
        request('POST', '/sessions/s1/messages', {userId: 'u1', text: 'hi'}),
      );

      expect(captured.chunks.at(-1)).toContain('event: error');
    });
  });

  describe('mounting', () => {
    it('passes unrelated paths through', async () => {
      const next = vi.fn();
      newGateway().endpoints({trustClientUserId: true})(
        request('GET', '/some/other/thing'),
        response(),
        next,
      );
      expect(next).toHaveBeenCalled();
    });

    it('honours a base path', async () => {
      const captured = await call(
        newGateway(),
        request('POST', '/api/agent/sessions', {userId: 'u1'}),
        {trustClientUserId: true, basePath: '/api/agent'},
      );
      expect(captured.status).toBe(201);
    });

    it('answers a CORS preflight', async () => {
      const captured = await call(
        newGateway(),
        request('OPTIONS', '/sessions'),
        {trustClientUserId: true, cors: {origin: 'https://example.com'}},
      );

      expect(captured.status).toBe(204);
      expect(captured.headers['access-control-allow-origin']).toBe(
        'https://example.com',
      );
    });
  });
});

describe('the event filter', () => {
  const textEvent = (text: string, partial = false): Event =>
    createEvent({
      invocationId: 'i',
      author: 'agent',
      partial,
      content: {role: 'model', parts: [{text}]},
    });

  const toolCallEvent = (): Event =>
    createEvent({
      invocationId: 'i',
      author: 'agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'c', name: 'search', args: {}}}],
      },
    });

  const interruptEvent = (): Event =>
    createEvent({
      invocationId: 'i',
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'interrupt-1',
              name: 'adk_request_confirmation',
              args: {
                originalFunctionCall: {id: 'c', name: 'wipe', args: {}},
                toolConfirmation: {hint: 'sure?', confirmed: false},
              },
            },
          },
        ],
      },
    });

  describe("'final'", () => {
    it('keeps the answer', () => {
      expect(applyFilter('final', textEvent('done'))).toBeDefined();
    });

    it('drops partial text, which would duplicate the answer', () => {
      expect(applyFilter('final', textEvent('do', true))).toBeUndefined();
    });

    it('drops tool calls', () => {
      expect(applyFilter('final', toolCallEvent())).toBeUndefined();
    });

    it('keeps interrupts', () => {
      // Filtering these out is how a UI ends up waiting forever on a question
      // it was never shown.
      expect(applyFilter('final', interruptEvent())).toBeDefined();
      expect(isFinalEvent(interruptEvent())).toBe(true);
    });

    it('keeps errors', () => {
      const failed = createEvent({
        invocationId: 'i',
        author: 'agent',
        errorCode: 'SAFETY',
      });
      expect(applyFilter('final', failed)).toBeDefined();
    });
  });

  describe("'all'", () => {
    it('keeps everything, as the debug server does', () => {
      expect(applyFilter('all', toolCallEvent())).toBeDefined();
      expect(applyFilter('all', textEvent('x', true))).toBeDefined();
    });
  });

  describe('a custom function', () => {
    it('can drop an event', () => {
      expect(applyFilter(() => undefined, textEvent('x'))).toBeUndefined();
    });

    it('can rewrite one, which a predicate could not', () => {
      const redact = (event: Event): Event => ({
        ...event,
        content: {role: 'model', parts: [{text: '[redacted]'}]},
      });
      const result = applyFilter(redact, textEvent('secret'));
      expect(result?.content?.parts?.[0].text).toBe('[redacted]');
    });
  });

  it('defaults to final on the wire', async () => {
    const gateway = newGateway();
    const seen: Event[] = [];
    for await (const event of gateway.run({
      userId: 'u',
      sessionId: 's',
      content: {role: 'user', parts: [{text: 'hi'}]},
    })) {
      seen.push(event);
    }

    expect(seen.every((event) => !event.partial)).toBe(true);
  });
});

describe('Gateway.run', () => {
  it('creates the session it is given', async () => {
    const gateway = newGateway();
    for await (const _ of gateway.run({
      userId: 'u',
      sessionId: 'fresh',
      content: {role: 'user', parts: [{text: 'hi'}]},
    })) {
      // drain
    }
    expect(await gateway.getSession('u', 'fresh')).toBeDefined();
  });

  it('serializes two turns on one session', async () => {
    const gateway = newGateway();
    const order: string[] = [];

    const turn = async (label: string) => {
      for await (const _ of gateway.run({
        userId: 'u',
        sessionId: 'shared',
        content: {role: 'user', parts: [{text: label}]},
      })) {
        order.push(label);
      }
      order.push(`end:${label}`);
    };

    await Promise.all([turn('a'), turn('b')]);

    // Interleaving would corrupt the transcript, so one must finish first.
    expect(order.indexOf('end:a')).toBeLessThan(order.lastIndexOf('b'));
  });
});
