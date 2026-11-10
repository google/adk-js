/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AlreadyExistsError,
  BaseAgent,
  createEvent,
  createEventActions,
  Event,
  InvocationContext,
  isStaleSessionError,
  RestSessionService,
  RestSessionServiceError,
  RestSessionServiceOptions,
  Runner,
  SessionNotFoundError,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

const BASE_URL = 'https://sessions.example.com/v1';

type Json = Record<string, unknown>;

interface StoredSession {
  id: string;
  appName: string;
  userId: string;
  state: Json;
  events: Json[];
  lastUpdateTime: number;
}

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Json;
}

/**
 * What the fake does to the next request before (or instead of) serving it.
 *
 * - a status: answer with it without touching storage;
 * - `'network'`: fail as if the connection dropped, without touching storage;
 * - `'lost-response'`: serve the request, then fail as if the response was
 *   lost on the way back;
 * - `'hang'`: never answer until the request is aborted.
 */
type Fault =
  | number
  | {status: number; retryAfter?: string}
  | 'network'
  | 'lost-response'
  | 'hang';

/**
 * An in-process backend that implements the REST session contract, used as
 * the `fetch` of the service under test.
 */
class FakeBackend {
  readonly sessions = new Map<string, StoredSession>();
  readonly appState = new Map<string, Json>();
  readonly userState = new Map<string, Json>();
  readonly requests: RecordedRequest[] = [];
  readonly faults: Fault[] = [];
  /** Delay applied to the request with this index, to test ordering. */
  readonly delays = new Map<number, number>();
  /** Epoch seconds; advanced by an amount that is not exact in binary. */
  private clock = 1_730_000_000.123456;

  readonly fetch = async (
    input: string | URL | Request,
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Json)
      : undefined;
    const index = this.requests.length;
    this.requests.push({method: init?.method ?? 'GET', url, headers, body});

    const delay = this.delays.get(index);
    if (delay) {
      await new Promise((r) => setTimeout(r, delay));
    }

    const fault = this.faults.shift();
    if (fault === 'network') {
      throw new TypeError('fetch failed');
    }
    if (fault === 'hang') {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    if (typeof fault === 'number') {
      return json(fault, {error: `injected ${fault}`});
    }
    if (typeof fault === 'object') {
      return json(
        fault.status,
        {error: 'injected'},
        fault.retryAfter ? {'Retry-After': fault.retryAfter} : {},
      );
    }

    const response = this.handle(init?.method ?? 'GET', url, body);
    if (fault === 'lost-response') {
      throw new TypeError('socket hang up');
    }
    return response;
  };

  /** Requests whose path ends with `suffix`. */
  requestsTo(method: string, suffix: string): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.method === method && r.url.pathname.endsWith(suffix),
    );
  }

  stored(appName: string, userId: string, id: string): StoredSession {
    const session = this.sessions.get(key(appName, userId, id));
    if (!session) {
      throw new Error(`no stored session ${id}`);
    }
    return session;
  }

  private tick(): number {
    this.clock += 1.000001;
    return this.clock;
  }

  private handle(method: string, url: URL, body?: Json): Response {
    const path = url.pathname.slice(new URL(BASE_URL).pathname.length);
    const segments = path.split('/').slice(1).map(decodeURIComponent);

    // /apps/{app}/sessions
    if (segments.length === 3 && segments[2] === 'sessions') {
      return this.list(url, segments[1]);
    }
    const [, appName, , userId, , sessionId, tail] = segments;
    if (segments.length === 5 && method === 'GET') {
      return this.list(url, appName, userId);
    }
    if (segments.length === 5 && method === 'POST') {
      return this.create(appName, userId, body ?? {});
    }
    const stored = this.sessions.get(key(appName, userId, sessionId));
    if (segments.length === 6 && method === 'GET') {
      return stored
        ? json(200, this.view(stored, url.searchParams))
        : json(404, {error: 'not found'});
    }
    if (segments.length === 6 && method === 'DELETE') {
      if (!stored) {
        return json(404, {error: 'not found'});
      }
      this.sessions.delete(key(appName, userId, sessionId));
      return new Response(null, {status: 204});
    }
    if (segments.length === 7 && tail === 'events' && method === 'POST') {
      return stored
        ? this.append(stored, body ?? {})
        : json(404, {error: 'not found'});
    }
    return json(400, {error: `unrouted ${method} ${path}`});
  }

  private create(appName: string, userId: string, body: Json): Response {
    const id = body['sessionId'] as string;
    if (this.sessions.has(key(appName, userId, id))) {
      return json(409, {error: 'exists'});
    }
    const session: StoredSession = {
      id,
      appName,
      userId,
      state: {},
      events: [],
      lastUpdateTime: this.tick(),
    };
    this.sessions.set(key(appName, userId, id), session);
    this.applyDelta(session, (body['state'] ?? {}) as Json);
    return json(200, this.view(session));
  }

  private append(session: StoredSession, body: Json): Response {
    const event = body['event'] as Json;
    const index = session.events.findIndex((e) => e['id'] === event['id']);
    if (index >= 0) {
      // A replay: replace the event, do not apply its delta again.
      session.events[index] = event;
      return json(200, {lastUpdateTime: session.lastUpdateTime});
    }
    if (session.lastUpdateTime > (body['lastUpdateTime'] as number)) {
      return json(409, {error: 'stale'});
    }
    const actions = event['actions'] as Json | undefined;
    this.applyDelta(session, (actions?.['stateDelta'] ?? {}) as Json);
    session.events.push(event);
    session.lastUpdateTime = this.tick();
    return json(200, {lastUpdateTime: session.lastUpdateTime});
  }

  private applyDelta(session: StoredSession, delta: Json): void {
    for (const [k, v] of Object.entries(delta)) {
      if (k.startsWith('app:')) {
        const app = this.appState.get(session.appName) ?? {};
        app[k.slice(4)] = v;
        this.appState.set(session.appName, app);
      } else if (k.startsWith('user:')) {
        const userKey = `${session.appName}/${session.userId}`;
        const user = this.userState.get(userKey) ?? {};
        user[k.slice(5)] = v;
        this.userState.set(userKey, user);
      } else {
        session.state[k] = v;
      }
    }
  }

  private view(session: StoredSession, params?: URLSearchParams): Json {
    const state: Json = {...session.state};
    for (const [k, v] of Object.entries(
      this.appState.get(session.appName) ?? {},
    )) {
      state[`app:${k}`] = v;
    }
    for (const [k, v] of Object.entries(
      this.userState.get(`${session.appName}/${session.userId}`) ?? {},
    )) {
      state[`user:${k}`] = v;
    }
    let events = session.events;
    const after = params?.get('afterTimestamp');
    if (after) {
      events = events.filter(
        (e) => (e['timestamp'] as number) >= Number(after),
      );
    }
    const recent = params?.get('numRecentEvents');
    if (recent) {
      events = events.slice(-Number(recent));
    }
    return {
      id: session.id,
      appName: session.appName,
      userId: session.userId,
      state,
      events,
      lastUpdateTime: session.lastUpdateTime,
    };
  }

  private list(url: URL, appName: string, userId?: string): Response {
    const sessions = [...this.sessions.values()]
      .filter((s) => s.appName === appName && (!userId || s.userId === userId))
      .map((s) => ({...this.view(s), events: []}));
    const limit = Number(url.searchParams.get('limit') ?? sessions.length);
    const page = Number(url.searchParams.get('page') ?? 1);
    return json(200, {
      sessions: sessions.slice((page - 1) * limit, page * limit),
      page,
      limit,
      totalItems: sessions.length,
      totalPages: limit ? Math.ceil(sessions.length / limit) : 0,
    });
  }
}

function key(appName: string, userId: string, id: string): string {
  return JSON.stringify([appName, userId, id]);
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json', ...headers},
  });
}

describe('RestSessionService', () => {
  let backend: FakeBackend;
  let service: RestSessionService;

  function makeService(options: Partial<RestSessionServiceOptions> = {}) {
    return new RestSessionService({
      baseUrl: BASE_URL,
      fetch: backend.fetch as typeof fetch,
      retryBaseDelayMs: 0,
      ...options,
    });
  }

  beforeEach(() => {
    backend = new FakeBackend();
    service = makeService();
  });

  it('requires a baseUrl', () => {
    expect(() => new RestSessionService({baseUrl: ''})).toThrow(/baseUrl/);
  });

  describe('createSession', () => {
    it('sends a client-generated id and the state without temp: keys', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
        state: {'topic': 'billing', 'temp:scratch': 1, 'user:lang': 'en'},
      });

      const [request] = backend.requestsTo(
        'POST',
        '/apps/app/users/user/sessions',
      );
      expect(request.body).toEqual({
        sessionId: session.id,
        state: {'topic': 'billing', 'user:lang': 'en'},
      });
      expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.state).toEqual({'topic': 'billing', 'user:lang': 'en'});
      expect(session.events).toEqual([]);
      // Epoch seconds on the wire, epoch milliseconds in ADK-JS.
      expect(session.lastUpdateTime).toBeCloseTo(
        backend.stored('app', 'user', session.id).lastUpdateTime * 1000,
        3,
      );
    });

    it('uses the caller-chosen id', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
        sessionId: 's1',
      });
      expect(session.id).toBe('s1');
      expect(backend.stored('app', 'user', 's1')).toBeDefined();
    });

    it('throws AlreadyExistsError on 409', async () => {
      await service.createSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
      });
      await expect(
        service.createSession({appName: 'app', userId: 'u', sessionId: 's'}),
      ).rejects.toBeInstanceOf(AlreadyExistsError);
    });

    it('returns the session its own lost attempt created', async () => {
      backend.faults.push('lost-response');

      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
        state: {a: 1},
      });

      expect(session.id).toBe('s');
      expect(session.state).toEqual({a: 1});
      expect(backend.sessions.size).toBe(1);
    });

    it('encodes path segments', async () => {
      await service.createSession({
        appName: 'my app',
        userId: 'a/b',
        sessionId: 's?1',
      });
      expect(backend.requests[0].url.pathname).toBe(
        '/v1/apps/my%20app/users/a%2Fb/sessions',
      );
      expect(backend.stored('my app', 'a/b', 's?1')).toBeDefined();
    });

    it('ignores a trailing slash on baseUrl', async () => {
      service = makeService({baseUrl: `${BASE_URL}/`});
      await service.createSession({appName: 'app', userId: 'u'});
      expect(backend.requests[0].url.pathname).toBe(
        '/v1/apps/app/users/u/sessions',
      );
    });
  });

  describe('getSession', () => {
    it('returns undefined on 404', async () => {
      expect(
        await service.getSession({appName: 'app', userId: 'u', sessionId: 'x'}),
      ).toBeUndefined();
    });

    it('passes numRecentEvents and afterTimestamp, converting units', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
      });
      for (const timestamp of [1_000, 2_000, 3_000]) {
        await service.appendEvent({
          session,
          event: createEvent({author: 'user', timestamp}),
        });
      }

      const read = await service.getSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
        config: {afterTimestamp: 2_000, numRecentEvents: 5},
      });

      const request = backend.requests.at(-1)!;
      expect(request.url.searchParams.get('afterTimestamp')).toBe('2');
      expect(request.url.searchParams.get('numRecentEvents')).toBe('5');
      expect(read!.events.map((e) => e.timestamp)).toEqual([2_000, 3_000]);
    });

    it('throws RestSessionServiceError on other errors', async () => {
      backend.faults.push(403);
      const error = await service
        .getSession({appName: 'app', userId: 'u', sessionId: 's'})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RestSessionServiceError);
      expect((error as RestSessionServiceError).status).toBe(403);
      expect((error as Error).message).toContain('injected 403');
    });
  });

  describe('listSessions', () => {
    beforeEach(async () => {
      await service.createSession({
        appName: 'app',
        userId: 'u1',
        sessionId: 'a',
      });
      await service.createSession({
        appName: 'app',
        userId: 'u1',
        sessionId: 'b',
      });
      await service.createSession({
        appName: 'app',
        userId: 'u2',
        sessionId: 'c',
      });
    });

    it("lists one user's sessions with pagination", async () => {
      const response = await service.listSessions({
        appName: 'app',
        userId: 'u1',
        limit: 1,
        page: 2,
        order: 'desc',
      });

      const params = backend.requests.at(-1)!.url.searchParams;
      expect(Object.fromEntries(params)).toEqual({
        limit: '1',
        page: '2',
        order: 'desc',
      });
      expect(response.sessions.map((s) => s.id)).toEqual(['b']);
      expect(response).toMatchObject({
        page: 2,
        limit: 1,
        totalItems: 2,
        totalPages: 2,
      });
    });

    it('lists every user through the app-level route', async () => {
      const response = await service.listSessions({appName: 'app'});
      expect(backend.requests.at(-1)!.url.pathname).toBe(
        '/v1/apps/app/sessions',
      );
      expect(response.sessions.map((s) => s.id).sort()).toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });

  describe('deleteSession', () => {
    it('deletes, and treats 404 as success', async () => {
      await service.createSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
      });
      await service.deleteSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
      });
      expect(backend.sessions.size).toBe(0);
      await expect(
        service.deleteSession({appName: 'app', userId: 'u', sessionId: 's'}),
      ).resolves.toBeUndefined();
    });
  });

  describe('appendEvent', () => {
    it('stores the event and applies its state locally and remotely', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
      });
      const event = createEvent({
        author: 'agent',
        timestamp: 1_730_000_000_500,
        actions: createEventActions({
          stateDelta: {'step': 1, 'user:lang': 'fr', 'temp:x': true},
        }),
      });

      await service.appendEvent({session, event});

      const sent = backend.requestsTo('POST', '/events')[0].body!;
      const sentEvent = sent['event'] as Json;
      expect(sentEvent['id']).toBe(event.id);
      expect(sentEvent['timestamp']).toBe(1_730_000_000.5);
      expect((sentEvent['actions'] as Json)['stateDelta']).toEqual({
        'step': 1,
        'user:lang': 'fr',
      });
      expect(session.state).toEqual({
        'step': 1,
        'user:lang': 'fr',
        'temp:x': true,
      });
      expect(event.actions.stateDelta).toEqual({'step': 1, 'user:lang': 'fr'});
      expect(session.events).toEqual([event]);

      const read = await service.getSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
      });
      expect(read!.state).toEqual({'step': 1, 'user:lang': 'fr'});
      expect(read!.events[0].id).toBe(event.id);
      expect(read!.events[0].timestamp).toBe(1_730_000_000_500);
      expect(read!.lastUpdateTime).toBe(session.lastUpdateTime);
    });

    it('does not send partial events', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
      });
      await service.appendEvent({
        session,
        event: createEvent({author: 'agent', partial: true}),
      });
      expect(backend.requestsTo('POST', '/events')).toHaveLength(0);
    });

    it('keeps the stale check exact across many appends', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
      });
      // Some of the server's timestamps do not survive seconds -> ms ->
      // seconds (the 35th tick is the first), which would read as stale if
      // the client sent back a converted value instead of the one it got.
      for (let i = 0; i < 50; i++) {
        await service.appendEvent({
          session,
          event: createEvent({
            author: 'agent',
            actions: createEventActions({stateDelta: {i}}),
          }),
        });
      }
      expect(session.state['i']).toBe(49);
    });

    it('throws StaleSessionError when another writer got there first', async () => {
      await service.createSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
      });
      const key = {appName: 'app', userId: 'u', sessionId: 's'};
      const mine = (await service.getSession(key))!;
      const theirs = (await service.getSession(key))!;
      await service.appendEvent({
        session: theirs,
        event: createEvent({author: 'agent'}),
      });

      const event = createEvent({
        author: 'agent',
        actions: createEventActions({stateDelta: {k: 'v'}}),
      });
      const error = await service
        .appendEvent({session: mine, event})
        .catch((e: unknown) => e);

      expect(isStaleSessionError(error)).toBe(true);
      // Nothing is applied to the local copy.
      expect(mine.events).toEqual([]);
      expect(mine.state).toEqual({});
    });

    it('throws SessionNotFoundError on 404', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
      });
      backend.sessions.clear();
      await expect(
        service.appendEvent({session, event: createEvent({author: 'agent'})}),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('retries an append whose response was lost without applying it twice', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
        sessionId: 's',
      });
      backend.faults.push('lost-response');

      await service.appendEvent({
        session,
        event: createEvent({
          author: 'agent',
          actions: createEventActions({stateDelta: {'app:count': 1}}),
        }),
      });

      const stored = backend.stored('app', 'u', 's');
      expect(stored.events).toHaveLength(1);
      expect(backend.requestsTo('POST', '/events')).toHaveLength(2);
      expect(session.events).toHaveLength(1);
      expect(session.state).toEqual({'app:count': 1});

      // The session is still current: the next append is not stale.
      await service.appendEvent({
        session,
        event: createEvent({author: 'agent'}),
      });
      expect(stored.events).toHaveLength(2);
    });

    it('sends the appends of one session in order', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
      });
      // Make the first append slow; the second must still wait for it.
      backend.delays.set(1, 30);

      const first = createEvent({author: 'agent', invocationId: 'first'});
      const second = createEvent({author: 'agent', invocationId: 'second'});
      await Promise.all([
        service.appendEvent({session, event: first}),
        service.appendEvent({session, event: second}),
      ]);

      const stored = backend.stored('app', 'u', session.id);
      expect(stored.events.map((e) => e['invocationId'])).toEqual([
        'first',
        'second',
      ]);
    });

    it('keeps the queue going after a failed append', async () => {
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
      });
      backend.faults.push(400);

      const results = await Promise.allSettled([
        service.appendEvent({session, event: createEvent({author: 'a'})}),
        service.appendEvent({session, event: createEvent({author: 'b'})}),
      ]);

      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
      expect(session.events.map((e) => e.author)).toEqual(['b']);
    });
  });

  describe('transport', () => {
    it('retries 408, 429 and 5xx, then succeeds', async () => {
      backend.faults.push(503, 408, {status: 429, retryAfter: '0'});
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
      });
      expect(session).toBeDefined();
      expect(backend.requests).toHaveLength(4);
    });

    it('does not retry other 4xx', async () => {
      backend.faults.push(400);
      await expect(
        service.createSession({appName: 'app', userId: 'u'}),
      ).rejects.toMatchObject({name: 'RestSessionServiceError', status: 400});
      expect(backend.requests).toHaveLength(1);
    });

    it('gives up after maxRetries', async () => {
      service = makeService({maxRetries: 2});
      backend.faults.push(500, 500, 500, 500);
      await expect(
        service.getSession({appName: 'app', userId: 'u', sessionId: 's'}),
      ).rejects.toMatchObject({status: 500});
      expect(backend.requests).toHaveLength(3);
    });

    it('retries network errors and reports the last one', async () => {
      service = makeService({maxRetries: 1});
      backend.faults.push('network', 'network');
      await expect(
        service.getSession({appName: 'app', userId: 'u', sessionId: 's'}),
      ).rejects.toThrow(/failed after 2 attempts: fetch failed/);
    });

    it('times out a hung attempt and retries it', async () => {
      service = makeService({timeoutMs: 10});
      backend.faults.push('hang');
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
      });
      expect(session).toBeDefined();
      expect(backend.requests).toHaveLength(2);
    });

    it('sends static headers', async () => {
      service = makeService({headers: {'Authorization': 'Bearer abc'}});
      await service.getSession({appName: 'app', userId: 'u', sessionId: 's'});
      expect(backend.requests[0].headers['authorization']).toBe('Bearer abc');
      expect(backend.requests[0].headers['accept']).toBe('application/json');
    });

    it('resolves a headers function on every attempt', async () => {
      let calls = 0;
      service = makeService({
        headers: async () => ({'X-Token': `t${++calls}`}),
      });
      backend.faults.push(503);
      await service.createSession({appName: 'app', userId: 'u'});
      expect(backend.requests.map((r) => r.headers['x-token'])).toEqual([
        't1',
        't2',
      ]);
      expect(backend.requests[0].headers['content-type']).toBe(
        'application/json',
      );
    });
  });

  describe('with a Runner', () => {
    class CountingAgent extends BaseAgent {
      readonly scratchSeen: unknown[] = [];

      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        const turns =
          ((context.session.state['user:turns'] as number) ?? 0) + 1;
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {role: 'model', parts: [{text: `turn ${turns}`}]},
          actions: createEventActions({
            stateDelta: {'user:turns': turns, 'temp:scratch': `x${turns}`},
          }),
        });
        this.scratchSeen.push(context.session.state['temp:scratch']);
      }

      protected override async *runLiveImpl(): AsyncGenerator<
        Event,
        void,
        void
      > {}
    }

    it('persists every turn through the backend', async () => {
      const agent = new CountingAgent({name: 'counter'});
      const runner = new Runner({
        appName: 'app',
        agent,
        sessionService: service,
      });
      const session = await service.createSession({
        appName: 'app',
        userId: 'u',
      });

      for (const text of ['one', 'two']) {
        for await (const _ of runner.runAsync({
          userId: 'u',
          sessionId: session.id,
          newMessage: {role: 'user', parts: [{text}]},
        })) {
          // Drain.
        }
      }

      const stored = backend.stored('app', 'u', session.id);
      expect(stored.events.map((e) => e['author'])).toEqual([
        'user',
        'counter',
        'user',
        'counter',
      ]);
      expect(backend.userState.get('app/u')).toEqual({turns: 2});
      expect(agent.scratchSeen).toEqual(['x1', 'x2']);
      const read = await service.getSession({
        appName: 'app',
        userId: 'u',
        sessionId: session.id,
      });
      expect(read!.state).toEqual({'user:turns': 2});
    });
  });
});
