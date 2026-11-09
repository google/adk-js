/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {resolveErrorType} from './error.js';

/** Bodies longer than this many characters are cut. */
const MAX_BODY_LENGTH = 1000;
const TRUNCATED_SUFFIX = '... [truncated]';
const SSE_BODY = '<SSE stream>';
const REDACTED_HEADER_VALUE = '<redacted>';
const REDACTED_QUERY_VALUE = 'REDACTED';

/** Headers whose values are credentials, and are never recorded. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

/** One HTTP request and its response, made safe to record. */
export interface HttpExchange {
  /** The request method, in upper case. */
  readonly method: string;
  /** The request URL without userinfo, with every query value redacted. */
  readonly url: string;
  /** The URL host name, without IPv6 brackets. */
  readonly serverAddress: string;
  /** The URL port, when the URL names one. */
  readonly serverPort?: number;
  /** The `sessionId` or `session_id` query value of the request URL. */
  readonly querySessionId?: string;
  readonly statusCode: number;
  /** Request headers by lowercased name, with credentials redacted. */
  readonly requestHeaders: ReadonlyMap<string, string>;
  /** Response headers by lowercased name, with credentials redacted. */
  readonly responseHeaders: ReadonlyMap<string, string>;
  /**
   * The request body, truncated. Absent when bodies are not captured, or when
   * the body cannot be read without consuming it.
   */
  readonly requestBody?: string;
  /**
   * The response body, truncated, or a marker for a body that is not read.
   * Absent when bodies are not captured.
   */
  readonly responseBody?: string;
}

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/** Parameters for {@link captureHttpExchange}. */
export interface CaptureHttpExchangeParams {
  readonly url: string | URL;
  readonly init?: Parameters<typeof fetch>[1];
  readonly response: Response;
  /** Whether to read the request and response bodies. */
  readonly captureBodies: boolean;
}

/**
 * Captures one HTTP exchange for recording.
 *
 * Everything it needs from `response` is taken before it returns, so the
 * caller may hand the response on as soon as this returns: the response body
 * is read from a clone in the background, and never for an event stream,
 * which does not end.
 */
export function captureHttpExchange({
  url,
  init,
  response,
  captureBodies,
}: CaptureHttpExchangeParams): Promise<HttpExchange> {
  const requestUrl = new URL(url);
  const isEventStream = (response.headers.get('content-type') ?? '')
    .toLowerCase()
    .includes('text/event-stream');
  const responseCopy =
    captureBodies && !isEventStream ? response.clone() : undefined;
  const requestBody = captureBodies ? readRequestBody(init?.body) : undefined;
  const exchange: HttpExchange = {
    method: (init?.method ?? 'GET').toUpperCase(),
    url: sanitizeUrl(requestUrl),
    serverAddress: requestUrl.hostname.replace(/^\[(.*)\]$/, '$1'),
    ...(requestUrl.port ? {serverPort: Number(requestUrl.port)} : {}),
    querySessionId: firstNonEmpty(
      requestUrl.searchParams.getAll('sessionId'),
      requestUrl.searchParams.getAll('session_id'),
    ),
    statusCode: response.status,
    requestHeaders: redactHeaders(new Headers(init?.headers)),
    responseHeaders: redactHeaders(response.headers),
    ...(requestBody === undefined ? {} : {requestBody}),
  };
  return withResponseBody(exchange, {
    captureBodies,
    isEventStream,
    responseCopy,
  });
}

/** Adds the response body to `exchange`, as far as it may be read. */
async function withResponseBody(
  exchange: HttpExchange,
  {
    captureBodies,
    isEventStream,
    responseCopy,
  }: {
    captureBodies: boolean;
    isEventStream: boolean;
    responseCopy: Response | undefined;
  },
): Promise<HttpExchange> {
  if (isEventStream) {
    return {...exchange, responseBody: SSE_BODY};
  }
  if (!captureBodies || responseCopy === undefined) {
    return exchange;
  }
  try {
    return {...exchange, responseBody: truncate(await responseCopy.text())};
  } catch (error: unknown) {
    // The error message can quote the payload, so only its type is kept.
    return {
      ...exchange,
      responseBody: `<failed to read body: ${resolveErrorType(error)}>`,
    };
  }
}

/**
 * Returns the request body as text, or `undefined` for a body that cannot be
 * read without consuming it, such as a stream.
 */
function readRequestBody(body: FetchInit['body']): string | undefined {
  if (typeof body === 'string') {
    return truncate(body);
  }
  if (body instanceof URLSearchParams) {
    return truncate(body.toString());
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return truncate(new TextDecoder().decode(body));
  }
  return undefined;
}

/**
 * Cuts `text` to its first {@link MAX_BODY_LENGTH} characters, counted as
 * code points so a cut never splits a surrogate pair.
 */
function truncate(text: string): string {
  // A string has at least as many UTF-16 units as code points.
  if (text.length <= MAX_BODY_LENGTH) {
    return text;
  }
  let end = 0;
  let count = 0;
  for (const character of text) {
    if (count === MAX_BODY_LENGTH) {
      return text.slice(0, end) + TRUNCATED_SUFFIX;
    }
    end += character.length;
    count++;
  }
  return text;
}

/**
 * Renders `url` without userinfo and with each query value replaced by
 * `REDACTED`. A key appears once, and a key with only empty values is dropped.
 */
function sanitizeUrl(url: URL): string {
  const sanitized = new URL(url);
  sanitized.username = '';
  sanitized.password = '';
  if (sanitized.search) {
    const keys = new Set<string>();
    for (const [key, value] of sanitized.searchParams) {
      if (value) {
        keys.add(key);
      }
    }
    sanitized.search = new URLSearchParams(
      Array.from(keys, (key) => [key, REDACTED_QUERY_VALUE]),
    ).toString();
  }
  return sanitized.href;
}

/** Returns header values by lowercased name, with credentials redacted. */
function redactHeaders(headers: Headers): ReadonlyMap<string, string> {
  const redacted = new Map<string, string>();
  headers.forEach((value, name) => {
    redacted.set(
      name,
      CREDENTIAL_HEADERS.has(name) ? REDACTED_HEADER_VALUE : value,
    );
  });
  return redacted;
}

function firstNonEmpty(
  ...candidates: ReadonlyArray<readonly string[]>
): string | undefined {
  return candidates.flat().find((value) => value !== '');
}
