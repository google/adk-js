/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP endpoints for talking to an agent.
 *
 * Middleware you mount on a server you already have, rather than a server of
 * its own. That is not only convenient: it is what puts your authentication in
 * front of these routes, since whatever you already use runs before this does.
 */

import type {Content} from '@google/genai';

import type {Gateway} from '../gateway.js';
import type {EventFilter} from '../render/filter.js';
import type {
  RouterMiddleware,
  RouterRequest,
  RouterResponse,
} from './router.js';

/** Identifies the caller from their request. */
export type ResolveUser = (
  request: RouterRequest,
) => string | undefined | Promise<string | undefined>;

/** How to mount the endpoints. */
export interface EndpointOptions {
  /** Prefix for every route. Defaults to `''`. */
  basePath?: string;

  /**
   * Where the user id comes from — your session cookie, a verified JWT, an API
   * key lookup.
   *
   * Required unless {@link trustClientUserId} is set. Sessions are keyed by
   * user, so taking this from the request body would let anyone read anyone
   * else's conversation by sending a different name.
   */
  resolveUser?: ResolveUser;

  /**
   * Take the user id from the request body instead.
   *
   * **Only for local development.** It means the caller chooses whose
   * conversations they can see. Named to be hard to enable by accident.
   */
  trustClientUserId?: boolean;

  /** Which events a client sees. Defaults to the gateway's own setting. */
  filter?: EventFilter;

  /** Cross-origin headers to set. Omitted by default. */
  cors?: {origin: string; credentials?: boolean};
}

/** A matched route. */
interface Route {
  method: string;
  pattern: RegExp;
  params: string[];
  handle: (context: RequestContext, response: RouterResponse) => Promise<void>;
}

/** What a handler is given. */
interface RequestContext {
  request: RouterRequest;
  params: Record<string, string>;
  userId: string;
  body: Record<string, unknown>;
}

/**
 * Builds middleware serving the chat API.
 *
 * ```
 * POST   {base}/sessions                create a conversation
 * GET    {base}/sessions/:id            its history
 * DELETE {base}/sessions/:id            start over
 * POST   {base}/sessions/:id/messages   say something; streams the reply
 * GET    {base}/health
 * ```
 */
export function createEndpoints(
  gateway: Gateway,
  options: EndpointOptions = {},
): RouterMiddleware {
  if (!options.resolveUser && !options.trustClientUserId) {
    throw new Error(
      'Gateway endpoints need to know who is calling: pass `resolveUser` to ' +
        'read the user id from your authentication, or `trustClientUserId: ' +
        'true` to take it from the request body (local development only — it ' +
        'lets a caller read anyone\u2019s conversations).',
    );
  }

  const base = normalizeBase(options.basePath);
  const routes = buildRoutes(gateway, options);

  return (request, response, next) => {
    const path = pathOf(request.url);
    if (!path.startsWith(base)) {
      next();
      return;
    }
    const local = path.slice(base.length) || '/';

    if (options.cors) {
      applyCors(response, options.cors);
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }
    }

    const matched = match(routes, request.method ?? 'GET', local);
    if (!matched) {
      next();
      return;
    }

    void handle(matched, request, response, options);
  };
}

async function handle(
  matched: {route: Route; params: Record<string, string>},
  request: RouterRequest,
  response: RouterResponse,
  options: EndpointOptions,
): Promise<void> {
  const body = (request.body ?? {}) as Record<string, unknown>;

  let userId: string | undefined;
  try {
    userId = options.resolveUser
      ? await options.resolveUser(request)
      : asString(body['userId']);
  } catch {
    userId = undefined;
  }

  if (!userId) {
    sendJson(response, 401, {error: 'Not authenticated.'});
    return;
  }

  try {
    await matched.route.handle(
      {request, params: matched.params, userId, body},
      response,
    );
  } catch (error) {
    // Headers are already out on a stream that failed midway; all that is left
    // is to close it, and the event stream carries its own error frame.
    if (!response.headersSent) {
      sendJson(response, 500, {error: describe(error)});
    } else {
      response.end();
    }
  }
}

function buildRoutes(gateway: Gateway, options: EndpointOptions): Route[] {
  return [
    route('GET', '/health', async (_context, response) => {
      sendJson(response, 200, {status: 'ok'});
    }),

    route('POST', '/sessions', async (context, response) => {
      const session = await gateway.createSession({
        userId: context.userId,
        sessionId: asString(context.body['sessionId']),
        state: context.body['state'] as Record<string, unknown> | undefined,
      });
      sendJson(response, 201, {sessionId: session.id, state: session.state});
    }),

    route('GET', '/sessions/:sessionId', async (context, response) => {
      const session = await gateway.getSession(
        context.userId,
        context.params['sessionId'],
      );
      if (!session) {
        sendJson(response, 404, {error: 'No such session.'});
        return;
      }
      sendJson(response, 200, {
        sessionId: session.id,
        state: session.state,
        events: session.events,
      });
    }),

    route('DELETE', '/sessions/:sessionId', async (context, response) => {
      await gateway.deleteSession(context.userId, context.params['sessionId']);
      response.statusCode = 204;
      response.end();
    }),

    route(
      'POST',
      '/sessions/:sessionId/messages',
      async (context, response) => {
        const content = contentFrom(context.body);
        if (!content) {
          sendJson(response, 400, {
            error: 'Send `text`, or a `content` object with parts.',
          });
          return;
        }

        const events = gateway.run({
          userId: context.userId,
          sessionId: context.params['sessionId'],
          content,
          filter: options.filter,
          signal: abortOnDisconnect(context.request),
        });

        if (wantsJson(context.request)) {
          const collected = [];
          for await (const event of events) {
            collected.push(event);
          }
          sendJson(response, 200, {events: collected});
          return;
        }

        await streamEvents(events, response);
      },
    ),
  ];
}

/**
 * Streams events as server-sent events.
 *
 * A failure mid-stream is delivered as an `error` frame rather than a dropped
 * connection, so a client can tell a failed turn from a finished one.
 */
async function streamEvents(
  events: AsyncIterable<unknown>,
  response: RouterResponse,
): Promise<void> {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream');
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('connection', 'keep-alive');
  response.flushHeaders?.();

  try {
    for await (const event of events) {
      response.write?.(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.write?.('event: done\ndata: {}\n\n');
  } catch (error) {
    response.write?.(
      `event: error\ndata: ${JSON.stringify({error: describe(error)})}\n\n`,
    );
  } finally {
    response.end();
  }
}

/** Aborts the run when the client hangs up, so we stop paying for the turn. */
function abortOnDisconnect(request: RouterRequest): AbortSignal | undefined {
  if (typeof request.on !== 'function') {
    return undefined;
  }
  const controller = new AbortController();
  request.on('close', () => controller.abort());
  request.on('aborted', () => controller.abort());
  return controller.signal;
}

/** Accepts either `{text}` or a full `{content}`. */
function contentFrom(body: Record<string, unknown>): Content | undefined {
  const explicit = body['content'] as Content | undefined;
  if (explicit?.parts?.length) {
    return {role: 'user', ...explicit};
  }
  const text = asString(body['text']);
  return text ? {role: 'user', parts: [{text}]} : undefined;
}

function route(method: string, path: string, handle: Route['handle']): Route {
  const params: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
      params.push(name);
      return '([^/]+)';
    })}/?$`,
  );
  return {method, pattern, params, handle};
}

function match(
  routes: readonly Route[],
  method: string,
  path: string,
): {route: Route; params: Record<string, string>} | undefined {
  for (const candidate of routes) {
    if (candidate.method !== method) {
      continue;
    }
    const found = candidate.pattern.exec(path);
    if (!found) {
      continue;
    }
    const params: Record<string, string> = {};
    candidate.params.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1]);
    });
    return {route: candidate, params};
  }
  return undefined;
}

function sendJson(
  response: RouterResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function applyCors(
  response: RouterResponse,
  cors: NonNullable<EndpointOptions['cors']>,
): void {
  response.setHeader('access-control-allow-origin', cors.origin);
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  if (cors.credentials) {
    response.setHeader('access-control-allow-credentials', 'true');
  }
}

function wantsJson(request: RouterRequest): boolean {
  const accept = request.headers['accept'];
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return (
    value.includes('application/json') && !value.includes('text/event-stream')
  );
}

function normalizeBase(basePath: string | undefined): string {
  if (!basePath || basePath === '/') {
    return '';
  }
  const trimmed = basePath.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
