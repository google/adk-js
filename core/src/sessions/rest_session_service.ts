/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AlreadyExistsError} from '../errors/already_exists_error.js';
import {SessionNotFoundError} from '../errors/session_not_found_error.js';
import {Event} from '../events/event.js';
import {experimental} from '../utils/experimental.js';
import {newId} from '../utils/id_provider.js';
import {logger} from '../utils/logger.js';

import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  trimTempState,
} from './base_session_service.js';
import {createSession, Session} from './session.js';
import {StaleSessionError} from './stale_session_error.js';

/**
 * Headers sent with every request: either a fixed map, or a function that is
 * called before each attempt (including retries), so it can return a freshly
 * minted token.
 */
export type RestSessionServiceHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

/**
 * Options for {@link RestSessionService}.
 */
export interface RestSessionServiceOptions {
  /**
   * Root URL of the session backend, such as
   * `https://sessions.example.com/v1`. Paths of the contract are appended to
   * it. A trailing slash is ignored.
   */
  baseUrl: string;
  /**
   * Headers sent with every request, for authentication, tenancy or anything
   * else the backend needs. The contract does not define an auth scheme.
   */
  headers?: RestSessionServiceHeaders;
  /** The `fetch` implementation to use. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Timeout of a single attempt, in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /**
   * How many times a request is retried after a network error, a timeout, or
   * a `408`, `429` or `5xx` response. Defaults to 3.
   */
  maxRetries?: number;
  /**
   * Delay before the first retry, in milliseconds. It doubles on every further
   * retry, with jitter. Defaults to 250.
   */
  retryBaseDelayMs?: number;
  /**
   * Upper bound of a single retry delay, in milliseconds, including one asked
   * for by a `Retry-After` header. Defaults to 5000.
   */
  retryMaxDelayMs?: number;
}

/**
 * Raised when the session backend answers with a status the client does not
 * map to another error, or cannot be reached after all retries.
 */
export class RestSessionServiceError extends Error {
  /**
   * @param message A description of the failed call.
   * @param status The HTTP status of the last response, if one was received.
   */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RestSessionServiceError';
    Object.setPrototypeOf(this, RestSessionServiceError.prototype);
  }
}

/** The outcome of a request once retries are done. */
interface RestResponse {
  status: number;
  body: unknown;
  /**
   * Whether an earlier attempt may have reached the server and been applied
   * before it failed (network error, timeout or `5xx`).
   */
  maybeAppliedEarlier: boolean;
}

interface SendOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * A session service backed by a user-hosted HTTP API.
 *
 * The agent process never connects to the session store. It calls a backend
 * that implements the REST session contract
 * (`docs/guides/sessions/rest_session_service_contract.md`), and that backend
 * owns storage, authentication, tenancy and retention.
 *
 * - Timestamps travel as epoch seconds, matching adk-python, and are converted
 *   to and from the epoch milliseconds ADK-JS uses.
 * - `temp:` state keys are never sent.
 * - Writes for one session are sent one at a time, in the order they were
 *   made, so state deltas reach the server in order.
 * - Appending an event is idempotent by `event.id`, so every call is retried
 *   on `408`, `429`, `5xx`, network errors and timeouts.
 * - A `409` on append surfaces as {@link StaleSessionError}, the same error
 *   `DatabaseSessionService` throws. Re-read the session and retry.
 */
@experimental
export class RestSessionService extends BaseSessionService {
  private readonly baseUrl: string;
  private readonly headers?: RestSessionServiceHeaders;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  /** The tail of the write queue of each session, keyed by session key. */
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  /**
   * The `lastUpdateTime` exactly as the server sent it, for each session
   * object. Sending it back verbatim keeps the stale-session check exact,
   * where converting seconds to milliseconds and back could be off by a
   * rounding error.
   */
  private readonly wireUpdateTimes = new WeakMap<
    Session,
    {millis: number; wire: number}
  >();

  constructor(options: RestSessionServiceOptions) {
    super();
    if (!options?.baseUrl) {
      throw new Error('RestSessionService requires a baseUrl.');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.headers = options.headers;
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs =
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  }

  override async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    // A client-chosen id makes the create safe to retry: a server-generated
    // one would create a second session when a retry follows a lost response.
    const id = sessionId?.trim() || newId();
    const response = await this.send('POST', sessionsPath(appName, userId), {
      body: {sessionId: id, state: state ? trimTempState(state) : undefined},
    });

    if (isSuccess(response.status)) {
      return this.toSession(response.body, {appName, userId, sessionId: id});
    }
    if (response.status === 409) {
      // The conflict may be with our own earlier attempt, which reached the
      // server before its response was lost.
      if (response.maybeAppliedEarlier) {
        const existing = await this.getSession({
          appName,
          userId,
          sessionId: id,
        });
        if (existing) {
          return existing;
        }
      }
      throw new AlreadyExistsError(`Session with id ${id} already exists.`);
    }
    throw requestError('create session', response);
  }

  override async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const response = await this.send(
      'GET',
      sessionPath(appName, userId, sessionId),
      {
        query: {
          numRecentEvents: config?.numRecentEvents,
          afterTimestamp:
            config?.afterTimestamp === undefined
              ? undefined
              : millisToWire(config.afterTimestamp),
        },
      },
    );

    if (response.status === 404) {
      return undefined;
    }
    if (isSuccess(response.status)) {
      return this.toSession(response.body, {appName, userId, sessionId});
    }
    throw requestError('get session', response);
  }

  override async listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const path =
      userId === undefined
        ? `/apps/${encodeURIComponent(appName)}/sessions`
        : sessionsPath(appName, userId);
    const response = await this.send('GET', path, {
      query: {limit, offset, page, order},
    });
    if (!isSuccess(response.status)) {
      throw requestError('list sessions', response);
    }

    const body = asRecord(response.body);
    if (!body || !Array.isArray(body['sessions'])) {
      throw new RestSessionServiceError(
        'Invalid list sessions response: expected an object with a `sessions` array.',
        response.status,
      );
    }
    const sessions = (body['sessions'] as unknown[]).map((s) =>
      this.toSession(s, {appName, userId: userId ?? ''}),
    );
    const totalItems = numberOr(body['totalItems'], sessions.length);
    return {
      sessions,
      page: numberOr(body['page'], 1),
      limit: numberOr(body['limit'], sessions.length),
      totalItems,
      totalPages: numberOr(body['totalPages'], totalItems === 0 ? 0 : 1),
    };
  }

  override async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    // Queued behind pending appends, so a delete is not overtaken by them.
    await this.enqueue(sessionKey(appName, userId, sessionId), async () => {
      const response = await this.send(
        'DELETE',
        sessionPath(appName, userId, sessionId),
      );
      if (isSuccess(response.status) || response.status === 404) {
        return;
      }
      throw requestError('delete session', response);
    });
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }

    return this.enqueue(
      sessionKey(session.appName, session.userId, session.id),
      async () => {
        const response = await this.send(
          'POST',
          `${sessionPath(session.appName, session.userId, session.id)}/events`,
          {
            body: {
              event: eventToWire(event),
              lastUpdateTime: this.wireUpdateTime(session),
            },
          },
        );

        if (response.status === 404) {
          throw new SessionNotFoundError(
            `Session ${session.id} not found for appendEvent.`,
          );
        }
        if (response.status === 409) {
          throw new StaleSessionError(
            `The session ${session.id} was modified by another writer since ` +
              `it was read (lastUpdateTime ${session.lastUpdateTime}). Re-read ` +
              `it with getSession and retry.`,
          );
        }
        if (!isSuccess(response.status)) {
          throw requestError('append event', response);
        }

        // Applied locally only once the server has stored the event, so a
        // failed append leaves the session object as it was. The base class
        // skips delta entries a newer in-process write has superseded, which
        // replacing `session.state` with the server's copy would undo. It also
        // keeps `temp:` keys in the session for the rest of the invocation
        // before trimming them from the event.
        await super.appendEvent({session, event});

        const wire = asRecord(response.body)?.['lastUpdateTime'];
        if (typeof wire === 'number') {
          this.setUpdateTime(session, wire);
        }
        return event;
      },
    );
  }

  /**
   * Runs `task` after every earlier task queued under `key` has settled, so
   * writes to one session reach the server in the order they were made.
   */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => task(),
      () => task(),
    );
    const tail = run.catch(() => undefined);
    this.writeQueues.set(key, tail);
    void tail.then(() => {
      if (this.writeQueues.get(key) === tail) {
        this.writeQueues.delete(key);
      }
    });
    return run;
  }

  /** Sends one request, retrying transient failures. */
  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    {query, body}: SendOptions = {},
  ): Promise<RestResponse> {
    const url = buildUrl(this.baseUrl, path, query);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let maybeAppliedEarlier = false;
    let retryAfterMs: number | undefined;
    let lastFailure = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.retryDelay(attempt, retryAfterMs));
      }
      retryAfterMs = undefined;

      const headers: Record<string, string> = {
        'Accept': 'application/json',
        ...(payload === undefined ? {} : {'Content-Type': 'application/json'}),
        ...(await this.resolveHeaders()),
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let status: number;
      let text: string;
      let retryAfterHeader: string | null;
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: payload,
          signal: controller.signal,
        });
        status = response.status;
        retryAfterHeader = response.headers?.get('Retry-After') ?? null;
        text = await response.text();
      } catch (e) {
        // A network error or timeout: the request may or may not have been
        // processed.
        maybeAppliedEarlier = true;
        lastFailure = controller.signal.aborted
          ? `timed out after ${this.timeoutMs} ms`
          : errorMessage(e);
        logger.debug(
          `RestSessionService: ${method} ${path} attempt ${attempt + 1} failed: ${lastFailure}`,
        );
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (isRetryable(status) && attempt < this.maxRetries) {
        if (status >= 500) {
          maybeAppliedEarlier = true;
        }
        retryAfterMs = parseRetryAfter(retryAfterHeader);
        lastFailure = `status ${status}`;
        logger.debug(
          `RestSessionService: ${method} ${path} attempt ${attempt + 1} returned ${status}; retrying.`,
        );
        continue;
      }

      return {status, body: parseBody(text, status), maybeAppliedEarlier};
    }

    throw new RestSessionServiceError(
      `${method} ${path} failed after ${this.maxRetries + 1} attempts: ${lastFailure}`,
    );
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    if (!this.headers) {
      return {};
    }
    return typeof this.headers === 'function'
      ? await this.headers()
      : this.headers;
  }

  private retryDelay(attempt: number, retryAfterMs?: number): number {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const jittered = backoff * (0.5 + Math.random() * 0.5);
    return Math.min(
      this.retryMaxDelayMs,
      Math.max(jittered, retryAfterMs ?? 0),
    );
  }

  /** Builds a session from a response body, filling gaps from the request. */
  private toSession(
    body: unknown,
    fallback: {appName: string; userId: string; sessionId?: string},
  ): Session {
    const record = asRecord(body);
    const id = record?.['id'] ?? fallback.sessionId;
    if (!record || typeof id !== 'string' || !id) {
      throw new RestSessionServiceError(
        'Invalid session in response: expected an object with a string `id`.',
      );
    }
    const state = asRecord(record['state']);
    const events = Array.isArray(record['events'])
      ? (record['events'] as unknown[]).map(eventFromWire)
      : [];
    const session = createSession({
      id,
      appName: stringOr(record['appName'], fallback.appName),
      userId: stringOr(record['userId'], fallback.userId),
      state: trimTempState(state ?? {}),
      events,
    });
    if (typeof record['lastUpdateTime'] === 'number') {
      this.setUpdateTime(session, record['lastUpdateTime']);
    }
    return session;
  }

  private setUpdateTime(session: Session, wire: number): void {
    session.lastUpdateTime = wireToMillis(wire);
    this.wireUpdateTimes.set(session, {millis: session.lastUpdateTime, wire});
  }

  private wireUpdateTime(session: Session): number {
    const recorded = this.wireUpdateTimes.get(session);
    return recorded && recorded.millis === session.lastUpdateTime
      ? recorded.wire
      : millisToWire(session.lastUpdateTime);
  }
}

function sessionsPath(appName: string, userId: string): string {
  return `/apps/${encodeURIComponent(appName)}/users/${encodeURIComponent(userId)}/sessions`;
}

function sessionPath(
  appName: string,
  userId: string,
  sessionId: string,
): string {
  return `${sessionsPath(appName, userId)}/${encodeURIComponent(sessionId)}`;
}

function sessionKey(
  appName: string,
  userId: string,
  sessionId: string,
): string {
  return JSON.stringify([appName, userId, sessionId]);
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return `${baseUrl}${path}${search ? `?${search}` : ''}`;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function parseBody(text: string, status: number): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    if (isSuccess(status)) {
      throw new RestSessionServiceError(
        `Invalid JSON in response with status ${status}.`,
        status,
      );
    }
    return text;
  }
}

function requestError(
  operation: string,
  response: RestResponse,
): RestSessionServiceError {
  const body = asRecord(response.body);
  const detail =
    typeof body?.['error'] === 'string'
      ? body['error']
      : typeof response.body === 'string'
        ? response.body
        : '';
  const message = `Failed to ${operation}: status ${response.status}${
    detail ? `: ${detail.slice(0, MAX_ERROR_MESSAGE_LENGTH)}` : ''
  }`;
  return new RestSessionServiceError(message, response.status);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

/** ADK-JS keeps epoch milliseconds; the wire carries epoch seconds. */
function millisToWire(millis: number): number {
  return millis / 1000;
}

function wireToMillis(seconds: number): number {
  return seconds * 1000;
}

/**
 * Serializes an event for the wire, without its `temp:` state delta keys. The
 * event itself is left untouched, so its `temp:` keys can still be applied to
 * the local session.
 */
function eventToWire(event: Event): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    ...event,
    timestamp: millisToWire(event.timestamp),
  };
  if (event.actions?.stateDelta) {
    wire['actions'] = {
      ...event.actions,
      stateDelta: trimTempState(event.actions.stateDelta),
    };
  }
  return wire;
}

function eventFromWire(value: unknown): Event {
  const record = asRecord(value);
  if (!record) {
    throw new RestSessionServiceError(
      'Invalid event in response: expected an object.',
    );
  }
  return {
    ...record,
    timestamp:
      typeof record['timestamp'] === 'number'
        ? wireToMillis(record['timestamp'])
        : 0,
  } as unknown as Event;
}
