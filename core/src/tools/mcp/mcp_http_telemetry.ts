/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Observes the HTTP exchanges of the MCP HTTP transports and reports each one
 * as an experimental OTel log record.
 */

import type {SSEClientTransportOptions} from '@modelcontextprotocol/sdk/client/sse.js';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import {context, type Context} from '@opentelemetry/api';

import {
  shouldCaptureMcpHttpBodies,
  traceMcpHttpExchange,
} from '../../telemetry/mcp_http_exchange.js';
import {isExperimentalTelemetryFeatureEnabled} from '../../telemetry/telemetry_context.js';
import {logger} from '../../utils/logger.js';

/** Header names whose values are never recorded. */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

const REDACTED_HEADER_VALUE = '<redacted>';
const REDACTED_QUERY_VALUE = 'REDACTED';

/** Bodies longer than this many characters are cut. */
const MAX_LOG_BODY_LENGTH = 1000;
const TRUNCATION_MARKER = '... [truncated]';

const SSE_CONTENT_TYPE = 'text/event-stream';
const SSE_BODY = '<SSE stream>';
const BINARY_BODY = '<binary>';

/** The `init` argument of a {@link FetchLike} call. */
type FetchInit = Parameters<FetchLike>[1];

const MCP_SESSION_ID_HEADER = 'mcp-session-id';
const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

/**
 * Returns whether MCP HTTP exchanges are reported. Read from the environment
 * only, because the transport has no invocation context to read a per-run
 * override from.
 */
export function shouldReportMcpHttpExchanges(): boolean {
  return isExperimentalTelemetryFeatureEnabled('mcp');
}

/** Returns `headers` with the values of credential headers replaced. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED_HEADER_VALUE : value,
    ]),
  );
}

/** Options for {@link sanitizeUrl}. */
export interface SanitizeUrlOptions {
  /** Replace each query value with `REDACTED`, as `url.full` asks. */
  redactQuery?: boolean;
}

/**
 * Renders `url` for recording, with any userinfo credential dropped.
 *
 * With `redactQuery`, the query keeps each distinct key that has a non-empty
 * value, with the value replaced. The session id, the one value worth keeping,
 * is recorded separately as `mcp.session.id`.
 */
export function sanitizeUrl(
  url: URL,
  {redactQuery = false}: SanitizeUrlOptions = {},
): string {
  const sanitized = new URL(url.href);
  sanitized.username = '';
  sanitized.password = '';
  if (redactQuery && url.search) {
    const keys = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (value) {
        keys.add(key);
      }
    }
    sanitized.search = [...keys]
      .map((key) => `${key}=${REDACTED_QUERY_VALUE}`)
      .join('&');
  }
  return sanitized.href;
}

/**
 * Cuts `body` at {@link MAX_LOG_BODY_LENGTH} code points, so a surrogate pair
 * is never split.
 */
export function truncateBody(body: string): string {
  if (body.length <= MAX_LOG_BODY_LENGTH) {
    return body;
  }
  let codePoints = 0;
  let end = 0;
  for (const char of body) {
    if (codePoints === MAX_LOG_BODY_LENGTH) {
      return body.slice(0, end) + TRUNCATION_MARKER;
    }
    codePoints++;
    end += char.length;
  }
  return body;
}

/** Returns the request body as text, or null when there is none. */
function readRequestBody(body: NonNullable<FetchInit>['body']): string | null {
  if (body === undefined || body === null || body === '') {
    return null;
  }
  if (typeof body === 'string') {
    return truncateBody(body);
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    if (body.byteLength === 0) {
      return null;
    }
    return truncateBody(new TextDecoder('utf-8').decode(body));
  }
  return BINARY_BODY;
}

/**
 * Starts reading the response body from a synchronous clone, without
 * consuming the original.
 */
function readResponseBody(response: Response): Promise<string> {
  try {
    const cloned = response.clone();
    return cloned.text().then(truncateBody, (e: unknown) => {
      const reason = e instanceof Error ? e.message : String(e);
      return `<failed to read body: ${reason}>`;
    });
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    return Promise.resolve(`<failed to read body: ${reason}>`);
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

interface ObservedExchange {
  url: string | URL;
  init: FetchInit;
  response: Response;
  otelContext: Context;
}

function emitExchangeRecord({
  requestUrl,
  requestHeaders,
  init,
  response,
  requestBody,
  responseBody,
  otelContext,
}: {
  requestUrl: URL;
  requestHeaders: Headers;
  init: FetchInit;
  response: Response;
  requestBody: string | null;
  responseBody: string | null;
  otelContext: Context;
}): void {
  const queryParams = requestUrl.searchParams;
  traceMcpHttpExchange({
    method: (init?.method ?? 'GET').toUpperCase(),
    url: sanitizeUrl(requestUrl, {redactQuery: true}),
    serverAddress: nonEmpty(requestUrl.hostname.replace(/^\[(.*)\]$/, '$1')),
    serverPort: requestUrl.port ? Number(requestUrl.port) : undefined,
    statusCode: response.status,
    // Three transports put the id in three places: the legacy `?sessionId=`
    // query, the initialize response, and every later request the client
    // echoes it on.
    mcpSessionId:
      nonEmpty(queryParams.get('sessionId')) ??
      nonEmpty(queryParams.get('session_id')) ??
      nonEmpty(response.headers.get(MCP_SESSION_ID_HEADER)) ??
      nonEmpty(requestHeaders.get(MCP_SESSION_ID_HEADER)),
    mcpProtocolVersion:
      nonEmpty(response.headers.get(MCP_PROTOCOL_VERSION_HEADER)) ??
      nonEmpty(requestHeaders.get(MCP_PROTOCOL_VERSION_HEADER)),
    requestHeaders: redactHeaders(headersToRecord(requestHeaders)),
    requestBody,
    responseHeaders: redactHeaders(headersToRecord(response.headers)),
    responseBody,
    context: otelContext,
  });
}

function reportExchange({
  url,
  init,
  response,
  otelContext,
}: ObservedExchange): void {
  const requestUrl = new URL(String(url));
  const requestHeaders = new Headers(init?.headers);
  const captureBodies = shouldCaptureMcpHttpBodies();
  const isSse = (response.headers.get('content-type') ?? '')
    .toLowerCase()
    .includes(SSE_CONTENT_TYPE);

  const requestBody = captureBodies ? readRequestBody(init?.body) : null;
  if (isSse || !captureBodies) {
    // Reading an SSE body would starve the transport of its events.
    const responseBody = isSse ? SSE_BODY : null;
    emitExchangeRecord({
      requestUrl,
      requestHeaders,
      init,
      response,
      requestBody,
      responseBody,
      otelContext,
    });
    return;
  }

  // Clone synchronously before returning `response` to the transport, then
  // read the clone in the background so body buffering does not block the
  // caller.
  void readResponseBody(response)
    .then((responseBody) => {
      emitExchangeRecord({
        requestUrl,
        requestHeaders,
        init,
        response,
        requestBody,
        responseBody,
        otelContext,
      });
    })
    .catch(() => {
      logger.warn('Failed to report MCP HTTP exchange');
    });
}

/**
 * Wraps `base` (or the global `fetch`) so each request and response pair is
 * reported as an MCP HTTP exchange record, parented to the context the request
 * was made in.
 *
 * Errors from `base` propagate unchanged and produce no record. An error while
 * observing is logged and never fails the request.
 */
export function createObservedFetch(base?: FetchLike): FetchLike {
  return async (url, init) => {
    const otelContext = context.active();
    const response = await (base ?? globalThis.fetch)(url, init);
    try {
      reportExchange({url, init, response, otelContext});
    } catch {
      logger.warn('Failed to report MCP HTTP exchange');
    }
    return response;
  };
}

/** The `fetch` an SSE transport's `EventSource` uses for its stream. */
type EventSourceFetch = NonNullable<
  NonNullable<SSEClientTransportOptions['eventSourceInit']>['fetch']
>;

/**
 * Wraps a caller-supplied `eventSourceInit.fetch` like
 * {@link createObservedFetch}, so the SSE stream request is reported too.
 */
export function createObservedEventSourceFetch(
  base: EventSourceFetch,
): EventSourceFetch {
  // The SSE transport calls this fetch with a full `RequestInit` and reads
  // the result as a `Response`, wider than the `eventsource` typings state.
  const observed = createObservedFetch(
    (url, init) =>
      base(url, init as Parameters<EventSourceFetch>[1]) as Promise<Response>,
  );
  return (url, init) => observed(url, init);
}
