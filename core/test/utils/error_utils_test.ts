/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {formatError} from '../../src/utils/error_utils.js';

const TRUNCATION_MARKER = '... [truncated]';
const MAX_RESPONSE_BODY_LENGTH = 1000;

/** Builds an axios/httpx-style error carrying a `.response` object. */
function httpError(status: number, body: string, statusText?: string): Error {
  return Object.assign(new Error(`request failed with status ${status}`), {
    response: {status, statusText, data: body},
  });
}

describe('formatError', () => {
  it('returns the message of a single plain error', () => {
    expect(formatError(new Error('normal error'))).toBe('normal error');
  });

  it('surfaces the leaf message of an error wrapped via cause', () => {
    const err = new Error('outer', {cause: new Error('root cause')});
    expect(formatError(err)).toContain('root cause');
  });

  it('joins an AggregateError of multiple sub-errors with " | "', () => {
    const err = new AggregateError([new Error('err A'), new Error('err B')]);
    const result = formatError(err);
    expect(result).toContain('err A');
    expect(result).toContain('err B');
    expect(result).toContain(' | ');
  });

  it('surfaces every leaf of an AggregateError mixing HTTP and plain errors', () => {
    const err = new AggregateError([
      httpError(403, 'Forbidden access', 'Forbidden'),
      new Error('another error'),
    ]);
    const result = formatError(err);
    expect(result).toContain('403');
    expect(result).toContain('Forbidden access');
    expect(result).toContain('another error');
  });

  it('extracts status and body from an HTTP 403 response shape', () => {
    const err = httpError(403, 'Forbidden access', 'Forbidden');
    const result = formatError(err);
    expect(result).toContain('403');
    expect(result).toContain('Forbidden access');
  });

  it('extracts status and body from an HTTP 401 response shape', () => {
    const err = httpError(401, 'Missing credentials', 'Unauthorized');
    const result = formatError(err);
    expect(result).toContain('401');
    expect(result).toContain('Missing credentials');
  });

  it('extracts the status from a StreamableHTTPError-shaped error', () => {
    const err = Object.assign(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"forbidden"}',
      ),
      {code: 403},
    );
    const result = formatError(err);
    expect(result).toContain('403');
    expect(result).toContain('forbidden');
  });

  it('truncates a long response body to the configured maximum', () => {
    const err = httpError(500, 'x'.repeat(5000));
    const result = formatError(err);
    expect(result).toContain(TRUNCATION_MARKER);
    expect(result).toContain('x'.repeat(MAX_RESPONSE_BODY_LENGTH));
    expect(result).not.toContain('x'.repeat(MAX_RESPONSE_BODY_LENGTH + 1));
  });

  it('does not truncate a body of exactly the maximum length', () => {
    const err = httpError(500, 'y'.repeat(MAX_RESPONSE_BODY_LENGTH));
    const result = formatError(err);
    expect(result).not.toContain(TRUNCATION_MARKER);
    expect(result).toContain('y'.repeat(MAX_RESPONSE_BODY_LENGTH));
  });

  it('truncates a body one character over the maximum length', () => {
    const err = httpError(500, 'z'.repeat(MAX_RESPONSE_BODY_LENGTH + 1));
    expect(formatError(err)).toContain(TRUNCATION_MARKER);
  });

  it('extracts HTTP details from a leaf error reached via the cause chain', () => {
    const err = new Error('connection failed', {
      cause: httpError(403, 'Forbidden access', 'Forbidden'),
    });
    const result = formatError(err);
    expect(result).toContain('403');
    expect(result).toContain('Forbidden access');
  });

  it('returns a stable constant for null and undefined', () => {
    expect(formatError(null)).toBe('Unknown error');
    expect(formatError(undefined)).toBe('Unknown error');
  });

  it('returns a raw string input verbatim', () => {
    expect(formatError('raw string')).toBe('raw string');
  });

  it('returns a non-empty string for a non-Error object without throwing', () => {
    const result = formatError({foo: 1});
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('is safe against a self-referential cause cycle', () => {
    const err = new Error('self');
    err.cause = err;
    expect(formatError(err)).toBe('self');
  });

  it('is safe against an AggregateError that contains itself', () => {
    const err = new AggregateError([new Error('leaf')]);
    err.errors.push(err);
    expect(() => formatError(err)).not.toThrow();
    expect(formatError(err)).toContain('leaf');
  });

  it('does not treat a string Node system code as an HTTP status', () => {
    const err = Object.assign(new Error('conn refused'), {
      code: 'ECONNREFUSED',
    });
    const result = formatError(err);
    expect(result).toBe('conn refused');
    expect(result).not.toContain('HTTP');
  });

  it('reads the status when the response object is null', () => {
    const err = Object.assign(new Error('boom'), {status: 403, response: null});
    expect(formatError(err)).toContain('403');
  });

  it('surfaces a response body even when no status is available', () => {
    const err = Object.assign(new Error('boom'), {
      response: {data: 'body without status'},
    });
    const result = formatError(err);
    expect(result).toContain('body without status');
    expect(result).toContain('HTTP error');
  });

  it('ignores a negative numeric code (e.g. JSON-RPC) as an HTTP status', () => {
    const err = Object.assign(new Error('rpc failure'), {code: -32601});
    const result = formatError(err);
    expect(result).toBe('rpc failure');
    expect(result).not.toContain('HTTP');
  });

  it('ignores an out-of-range numeric code as an HTTP status', () => {
    const err = Object.assign(new Error('weird code'), {code: 9999});
    const result = formatError(err);
    expect(result).toBe('weird code');
    expect(result).not.toContain('9999');
  });

  it('does not invoke or surface a function-valued response text', () => {
    const err = Object.assign(new Error('boom'), {
      response: {status: 500, text: () => 'should not be read'},
    });
    const result = formatError(err);
    expect(result).toContain('500');
    expect(result).not.toContain('should not be read');
  });

  it('returns the unknown-error constant for an empty AggregateError', () => {
    expect(formatError(new AggregateError([]))).toBe('Unknown error');
  });

  it('does not append the cause when the base already has HTTP details', () => {
    const err = Object.assign(new Error('outer'), {
      code: 403,
      cause: new Error('inner detail'),
    });
    const result = formatError(err);
    expect(result).toContain('HTTP 403');
    expect(result).not.toContain('inner detail');
  });

  it('does not duplicate a cause message already present in the base', () => {
    const err = new Error('wrapper failed: boom', {cause: new Error('boom')});
    expect(formatError(err)).toBe('wrapper failed: boom');
  });

  it('reads a string response body from the "body" field', () => {
    const err = Object.assign(new Error('boom'), {
      response: {status: 502, body: 'gateway body'},
    });
    expect(formatError(err)).toContain('gateway body');
  });

  it('reads a string response body from the "text" field', () => {
    const err = Object.assign(new Error('boom'), {
      response: {status: 502, text: 'text body'},
    });
    expect(formatError(err)).toContain('text body');
  });
});
