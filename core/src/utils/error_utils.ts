/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for turning arbitrary thrown values into readable, root-cause
 * messages, so that wrapped, aggregated or HTTP-flavoured failures are not
 * reduced to an empty or generic string when they are reported.
 */

/**
 * Maximum number of characters of an HTTP response body surfaced by
 * {@link formatError} before it is truncated. Bounds both log volume and the
 * exposure of potentially sensitive response payloads.
 */
const MAX_RESPONSE_BODY_LENGTH = 1000;

/** Marker appended to a response body that exceeds {@link MAX_RESPONSE_BODY_LENGTH}. */
const TRUNCATION_MARKER = '... [truncated]';

/** Returned by {@link formatError} when the input carries no usable message. */
const UNKNOWN_ERROR = 'Unknown error';

/** Lowest and highest values treated as an HTTP status code. */
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/**
 * Narrows an arbitrary value to an indexable record, or `undefined` when it is
 * not a non-null object. Used to safely inspect duck-typed error shapes without
 * resorting to `any`.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns the first argument that is a string, or `undefined` if none are. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/** Truncates a response body to {@link MAX_RESPONSE_BODY_LENGTH} characters. */
function truncateBody(body: string): string {
  return body.length > MAX_RESPONSE_BODY_LENGTH
    ? body.slice(0, MAX_RESPONSE_BODY_LENGTH) + TRUNCATION_MARKER
    : body;
}

/** Returns the plain, non-recursive message for a single value. */
function baseMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/**
 * Extracts synchronously-available HTTP details (status, status text and a
 * truncated response body) from a duck-typed error, or `undefined` when none
 * are present. Several shapes are supported: errors carrying `.status`
 * directly, axios/httpx-style errors nesting them under `.response`, and
 * errors that expose the status as a numeric `.code` (as the MCP SDK's
 * `StreamableHTTPError` does). A body is only read when it is already a
 * string, so no async `Response.text()` is ever invoked.
 */
function extractHttpDetails(err: unknown): string | undefined {
  const record = asRecord(err);
  if (record === undefined) {
    return undefined;
  }
  const response = asRecord(record['response']);
  const rawStatus = record['status'] ?? record['code'] ?? response?.['status'];
  const status =
    typeof rawStatus === 'number' &&
    rawStatus >= MIN_HTTP_STATUS &&
    rawStatus <= MAX_HTTP_STATUS
      ? rawStatus
      : undefined;
  const statusText = firstString(
    record['statusText'],
    response?.['statusText'],
  );
  const body = firstString(
    response?.['data'],
    response?.['body'],
    response?.['text'],
  );
  if (status === undefined && body === undefined) {
    return undefined;
  }
  const head =
    status === undefined
      ? 'HTTP error'
      : `HTTP ${status}${statusText === undefined ? '' : ` ${statusText}`}`;
  return body === undefined ? head : `${head}: ${truncateBody(body)}`;
}

/**
 * Recursively flattens aggregate and wrapped errors into a single message.
 * `seen` guards against cyclic `cause`/`errors` graphs.
 */
function formatErrorRecursive(err: unknown, seen: Set<unknown>): string {
  if (err === null || err === undefined) {
    return UNKNOWN_ERROR;
  }
  if (typeof err === 'object') {
    if (seen.has(err)) {
      return baseMessage(err);
    }
    seen.add(err);
  }
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map((sub) => formatErrorRecursive(sub, seen)).join(' | ');
  }
  const http = extractHttpDetails(err);
  const base = baseMessage(err);
  // Cycles (including a direct `err.cause === err`) are handled by `seen`.
  const cause = asRecord(err)?.['cause'];
  const causeMessage =
    cause !== undefined ? formatErrorRecursive(cause, seen) : undefined;
  let message = base.length > 0 ? base : UNKNOWN_ERROR;
  if (http !== undefined) {
    message = `${message} (${http})`;
  }
  if (
    causeMessage !== undefined &&
    http === undefined &&
    !message.includes(causeMessage)
  ) {
    message = `${message}: ${causeMessage}`;
  }
  return message;
}

/**
 * Formats an arbitrary thrown value into a readable, root-cause message.
 *
 * Recursively flattens `AggregateError.errors` (joining leaves with ` | `) and
 * unwraps the `Error.cause` chain, and — when HTTP details are synchronously
 * available — appends the status code and a response-body snippet truncated to
 * 1000 characters with a `... [truncated]` marker. It never throws and is safe
 * on `null`/`undefined` and cyclic error graphs.
 *
 * @param err The thrown or rejected value to format.
 * @return A single human-readable message describing the root cause(s).
 */
export function formatError(err: unknown): string {
  return formatErrorRecursive(err, new Set<unknown>());
}
