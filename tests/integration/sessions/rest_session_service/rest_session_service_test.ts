/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs a real agent through `RestSessionService` against a session backend
 * served over HTTP on a loopback port, with the real `fetch` in between.
 *
 * The backend is a minimal in-memory implementation of
 * `docs/guides/sessions/rest_session_service_contract.md`. The model is
 * replayed from `model_responses.json`, recorded from a live Gemini run. To
 * re-record, with Vertex AI credentials:
 *
 *   RECORD_MODEL_RESPONSES=1 GOOGLE_GENAI_USE_VERTEXAI=true \
 *   GOOGLE_CLOUD_PROJECT=<project> GOOGLE_CLOUD_LOCATION=us-central1 \
 *   npx vitest run --project integration tests/integration/sessions/rest_session_service
 */

import {
  Event,
  FunctionTool,
  LlmAgent,
  RestSessionService,
  Runner,
  Session,
} from '@google/adk';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import {AddressInfo} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  drainRecordedCalls,
  installRecordReplay,
  RecordedCall,
  restoreRecordReplay,
} from '../../workflows/_harness/record_replay_model.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'model_responses.json',
);
const RECORDING = process.env['RECORD_MODEL_RESPONSES'] === '1';
const TOKEN = 'test-token';
const APP_NAME = 'shopping_app';
const USER_ID = 'user-1';

type Json = Record<string, unknown>;

interface StoredEvent {
  event: Json;
  requestId: string;
  lastUpdateTime: number;
}

interface StoredSession {
  id: string;
  appName: string;
  userId: string;
  state: Json;
  events: StoredEvent[];
  lastUpdateTime: number;
}

interface LoggedRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: Json;
}

/** A session backend that implements the REST session contract in memory. */
class SessionBackend {
  readonly sessions = new Map<string, StoredSession>();
  readonly appState = new Map<string, Json>();
  readonly userState = new Map<string, Json>();
  readonly log: LoggedRequest[] = [];
  private lastMillis = 0;
  private server?: http.Server;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      void this.serve(req, res);
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    const {port} = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  stored(sessionId: string): StoredSession {
    const session = this.sessions.get(key(APP_NAME, USER_ID, sessionId));
    if (!session) {
      throw new Error(`No stored session ${sessionId}.`);
    }
    return session;
  }

  private async serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let text = '';
    for await (const chunk of req) {
      text += String(chunk);
    }
    const body = text ? (JSON.parse(text) as Json) : undefined;
    this.log.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      authorization: req.headers.authorization,
      body,
    });

    const reply = (status: number, payload?: unknown) => {
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return reply(401, {error: 'unauthenticated'});
    }

    const segments = url.pathname
      .replace(/^\/v1/, '')
      .split('/')
      .slice(1)
      .map(decodeURIComponent);
    const [, appName, , userId, , sessionId, tail] = segments;
    if (segments.length === 5 && req.method === 'POST') {
      return reply(...this.create(appName, userId, body ?? {}));
    }
    if (segments.length === 5 && req.method === 'GET') {
      return reply(200, this.list(appName, userId));
    }
    const stored = this.sessions.get(key(appName, userId, sessionId));
    if (!stored) {
      return reply(404, {error: 'not found'});
    }
    if (segments.length === 6 && req.method === 'GET') {
      return reply(200, this.view(stored, url.searchParams));
    }
    if (segments.length === 6 && req.method === 'DELETE') {
      this.sessions.delete(key(appName, userId, sessionId));
      return reply(204);
    }
    if (segments.length === 7 && tail === 'events' && req.method === 'POST') {
      return reply(...this.append(stored, body ?? {}));
    }
    return reply(400, {error: `unrouted ${req.method} ${url.pathname}`});
  }

  /** A strictly increasing whole number of milliseconds, in seconds. */
  private nextUpdateTime(): number {
    this.lastMillis = Math.max(Date.now(), this.lastMillis + 1);
    return this.lastMillis / 1000;
  }

  private create(
    appName: string,
    userId: string,
    body: Json,
  ): [number, unknown] {
    const id = body['sessionId'] as string;
    if (this.sessions.has(key(appName, userId, id))) {
      return [409, {error: 'exists'}];
    }
    const session: StoredSession = {
      id,
      appName,
      userId,
      state: {},
      events: [],
      lastUpdateTime: this.nextUpdateTime(),
    };
    this.sessions.set(key(appName, userId, id), session);
    this.applyDelta(session, (body['state'] ?? {}) as Json);
    return [201, this.view(session)];
  }

  private append(session: StoredSession, body: Json): [number, unknown] {
    const event = body['event'] as Json;
    const requestId = body['requestId'] as string;
    const index = session.events.findIndex(
      (e) => e.event['id'] === event['id'],
    );
    const existing = index >= 0 ? session.events[index] : undefined;
    if (existing?.requestId === requestId) {
      return [200, {lastUpdateTime: existing.lastUpdateTime}];
    }
    if (session.lastUpdateTime !== body['lastUpdateTime']) {
      return [409, {error: 'stale'}];
    }
    const actions = event['actions'] as Json | undefined;
    this.applyDelta(session, (actions?.['stateDelta'] ?? {}) as Json);
    session.lastUpdateTime = this.nextUpdateTime();
    const stored = {event, requestId, lastUpdateTime: session.lastUpdateTime};
    if (existing) {
      session.events[index] = stored;
    } else {
      session.events.push(stored);
    }
    return [200, {lastUpdateTime: session.lastUpdateTime}];
  }

  private applyDelta(session: StoredSession, delta: Json): void {
    const scoped = (map: Map<string, Json>, mapKey: string) => {
      const value = map.get(mapKey) ?? {};
      map.set(mapKey, value);
      return value;
    };
    for (const [k, v] of Object.entries(delta)) {
      if (k.startsWith('app:')) {
        scoped(this.appState, session.appName)[k.slice(4)] = v;
      } else if (k.startsWith('user:')) {
        scoped(this.userState, `${session.appName}/${session.userId}`)[
          k.slice(5)
        ] = v;
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
    let events = session.events.map((e) => e.event);
    const after = params?.get('afterTimestamp');
    if (after) {
      events = events.filter((e) => (e['timestamp'] as number) >= +after);
    }
    const recent = params?.get('numRecentEvents');
    if (recent) {
      events = +recent === 0 ? [] : events.slice(-recent);
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

  private list(appName: string, userId: string): Json {
    const sessions = [...this.sessions.values()]
      .filter((s) => s.appName === appName && s.userId === userId)
      .map((s) => ({...this.view(s), events: []}));
    return {sessions};
  }
}

function key(appName: string, userId: string, sessionId: string): string {
  return JSON.stringify([appName, userId, sessionId]);
}

function createShoppingAgent(): LlmAgent {
  const addToCart = new FunctionTool({
    name: 'add_to_cart',
    description: "Adds an item to the user's shopping cart.",
    parameters: z.object({
      item: z.string().describe('Singular, lowercase item name.'),
      quantity: z.number().int().min(1),
    }),
    execute: ({item, quantity}, toolContext) => {
      const cart: Record<string, number> = {
        ...toolContext?.state.get<Record<string, number>>('user:cart'),
      };
      cart[item] = (cart[item] ?? 0) + quantity;
      toolContext?.state.set('user:cart', cart);
      toolContext?.state.set('temp:last_added', item);
      return {cart};
    },
  });

  return new LlmAgent({
    name: 'shopping_assistant',
    model: 'gemini-2.5-flash',
    instruction:
      "You are a shopping assistant. The user's cart is: {user:cart?}. " +
      'When the user asks to add items, call add_to_cart once per item, ' +
      'with singular lowercase item names. Then answer in one short sentence.',
    tools: [addToCart],
    outputKey: 'last_reply',
  });
}

/** Runs one user turn and returns the events the runner yielded. */
async function runTurn(
  runner: Runner,
  sessionId: string,
  text: string,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId,
    newMessage: {role: 'user', parts: [{text}]},
  })) {
    events.push(event);
  }
  return events;
}

function finalText(events: Event[]): string {
  const last = events.at(-1);
  return (last?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}

/** Every key at any depth of a JSON value. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(allKeys);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
  }
  return [];
}

describe('RestSessionService over HTTP with a recorded agent run', () => {
  const backend = new SessionBackend();
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await backend.start();
    if (!RECORDING && !existsSync(FIXTURE)) {
      throw new Error(
        `Missing fixture ${FIXTURE}. Record it as described at the top of this file.`,
      );
    }
    installRecordReplay({
      mode: RECORDING ? 'record' : 'replay',
      recordedCalls: RECORDING
        ? []
        : (JSON.parse(readFileSync(FIXTURE, 'utf8')) as RecordedCall[]),
      fixtureId: FIXTURE,
    });
  });

  afterAll(async () => {
    if (RECORDING) {
      writeFileSync(
        FIXTURE,
        JSON.stringify(drainRecordedCalls(), null, 2) + '\n',
      );
    }
    restoreRecordReplay();
    await backend.stop();
  });

  function createService(): RestSessionService {
    return new RestSessionService({
      baseUrl,
      headers: async () => ({Authorization: `Bearer ${TOKEN}`}),
    });
  }

  let firstSession: Session;
  let firstSessionEvents: Event[];

  it('persists a multi-turn, tool-calling conversation through the backend', async () => {
    const service = createService();
    const runner = new Runner({
      appName: APP_NAME,
      agent: createShoppingAgent(),
      sessionService: service,
    });
    firstSession = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    const turn1 = await runTurn(
      runner,
      firstSession.id,
      'Please add 2 apples to my cart.',
    );
    const turn2 = await runTurn(
      runner,
      firstSession.id,
      'Also add a loaf of bread, then tell me everything in my cart.',
    );
    firstSessionEvents = [...turn1, ...turn2];

    const toolCalls = firstSessionEvents.flatMap((e) =>
      (e.content?.parts ?? []).filter((p) => p.functionCall),
    );
    expect(toolCalls.map((p) => p.functionCall!.args)).toEqual([
      {item: 'apple', quantity: 2},
      {item: 'bread', quantity: 1},
    ]);

    const stored = backend.stored(firstSession.id);
    expect(backend.userState.get(`${APP_NAME}/${USER_ID}`)).toEqual({
      cart: {apple: 2, bread: 1},
    });
    expect(stored.state).toEqual({last_reply: finalText(turn2)});

    // The backend holds the two user messages and every event the runner
    // yielded, in order.
    const storedEvents = stored.events.map((e) => e.event);
    expect(storedEvents.filter((e) => e['author'] === 'user')).toHaveLength(2);
    expect(
      storedEvents.filter((e) => e['author'] !== 'user').map((e) => e['id']),
    ).toEqual(firstSessionEvents.map((e) => e.id));
  });

  it('sends only what the contract allows over the wire', () => {
    expect(backend.log.length).toBeGreaterThan(0);
    for (const request of backend.log) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(
        allKeys(request.body).filter((k) => k.startsWith('temp:')),
      ).toEqual([]);
    }

    const appends = backend.log.filter((r) => r.path.endsWith('/events'));
    expect(appends.length).toBeGreaterThanOrEqual(6);
    const requestIds = appends.map((r) => r.body?.['requestId']);
    expect(new Set(requestIds).size).toBe(appends.length);
    for (const append of appends) {
      const event = append.body?.['event'] as Json;
      // Epoch seconds: an epoch-milliseconds value would be 1000x larger.
      expect(event['timestamp']).toBeLessThan(1e11);
      expect(append.body?.['lastUpdateTime']).toBeLessThan(1e11);
    }
  });

  it('reads the conversation back unchanged through a fresh client', async () => {
    const read = await createService().getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: firstSession.id,
    });

    expect(read!.state).toEqual({
      'last_reply': finalText(firstSessionEvents),
      'user:cart': {apple: 2, bread: 1},
    });
    expect(read!.events.filter((e) => e.author !== 'user')).toEqual(
      firstSessionEvents,
    );
    expect(read!.lastUpdateTime / 1000).toBe(
      backend.stored(firstSession.id).lastUpdateTime,
    );
  });

  it('shares user: state with a new session of the same user', async () => {
    const service = createService();
    const runner = new Runner({
      appName: APP_NAME,
      agent: createShoppingAgent(),
      sessionService: service,
    });
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    expect(session.state).toEqual({'user:cart': {apple: 2, bread: 1}});

    const events = await runTurn(runner, session.id, "What's in my cart?");

    expect(
      events.some((e) => (e.content?.parts ?? []).some((p) => p.functionCall)),
    ).toBe(false);
    expect(finalText(events).toLowerCase()).toMatch(/apple/);
    expect(finalText(events).toLowerCase()).toMatch(/bread/);

    const listed = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });
    expect(listed.sessions.map((s) => s.id).sort()).toEqual(
      [firstSession.id, session.id].sort(),
    );
  });

  it('rejects a write from a stale copy after the agent moved on', async () => {
    const service = createService();
    const stale = (await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: firstSession.id,
    }))!;
    const runner = new Runner({
      appName: APP_NAME,
      agent: createShoppingAgent(),
      sessionService: service,
    });
    await runTurn(runner, firstSession.id, 'Thanks, that is all.');

    await expect(
      service.appendEvent({
        session: stale,
        event: firstSessionEvents[0],
      }),
    ).rejects.toMatchObject({name: 'StaleSessionError'});
  });
});
