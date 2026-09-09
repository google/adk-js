/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';
import {describe, expect, it} from 'vitest';

import {
  isRequestOriginAllowed,
  normalizeOrigin,
  parseAllowedOrigins,
} from '../../src/server/origin_check.js';

const PORT = 8000;

function headers(host?: string): http.IncomingHttpHeaders {
  return {host};
}

describe('normalizeOrigin', () => {
  it('strips a trailing slash so the browser Origin matches', () => {
    expect(normalizeOrigin('http://localhost:4200/')).toBe(
      'http://localhost:4200',
    );
  });

  it('passes the wildcard through unchanged', () => {
    expect(normalizeOrigin('*')).toBe('*');
  });

  it('rejects a scheme-less entry whose opaque origin is "null"', () => {
    // `new URL('localhost:4200').origin` is the string "null"; accepting it
    // would allowlist every opaque origin.
    expect(normalizeOrigin('localhost:4200')).toBeNull();
  });

  it('rejects a non-http(s) scheme and an unparseable entry', () => {
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
  });
});

describe('parseAllowedOrigins', () => {
  it('normalizes and keeps http(s) origins and the wildcard', () => {
    expect(
      parseAllowedOrigins('http://localhost:4200/, https://a.example, *'),
    ).toEqual({
      origins: ['http://localhost:4200', 'https://a.example', '*'],
      rejected: [],
    });
  });

  it('drops a scheme-less entry so it never reaches the allowlist', () => {
    // The blocking bug: `localhost:4200` otherwise normalizes to the opaque
    // "null" origin and grants every `Origin: null` request.
    expect(parseAllowedOrigins('localhost:4200')).toEqual({
      origins: [],
      rejected: ['localhost:4200'],
    });
  });

  it('drops an invalid entry while keeping a valid sibling', () => {
    expect(parseAllowedOrigins('file:///x, https://ok.example')).toEqual({
      origins: ['https://ok.example'],
      rejected: ['file:///x'],
    });
  });

  it('returns empty lists for an unset or blank value', () => {
    expect(parseAllowedOrigins(undefined)).toEqual({origins: [], rejected: []});
    expect(parseAllowedOrigins('  ,  ')).toEqual({origins: [], rejected: []});
  });
});

describe('isRequestOriginAllowed', () => {
  it('blocks a cross-origin request', () => {
    expect(
      isRequestOriginAllowed(
        'http://evil.com',
        headers(`localhost:${PORT}`),
        [],
      ),
    ).toBe(false);
  });

  it('allows a same-origin request', () => {
    expect(
      isRequestOriginAllowed(
        `http://localhost:${PORT}`,
        headers(`localhost:${PORT}`),
        [],
      ),
    ).toBe(true);
  });

  it('allows an explicitly configured origin', () => {
    expect(
      isRequestOriginAllowed(
        'http://localhost:4200',
        headers(`localhost:${PORT}`),
        ['http://localhost:4200'],
      ),
    ).toBe(true);
  });

  it('allows any origin when the wildcard is configured', () => {
    expect(
      isRequestOriginAllowed('http://evil.com', headers(`localhost:${PORT}`), [
        '*',
      ]),
    ).toBe(true);
  });

  it('blocks a request whose own origin cannot be determined', () => {
    expect(
      isRequestOriginAllowed('http://evil.com', headers(undefined), []),
    ).toBe(false);
  });

  it('blocks a literal "null" Origin via the malformed-URL path', () => {
    // A sandboxed iframe or a data:/file: document sends `Origin: null`. It is
    // not on the allowlist and `new URL('null')` throws, so it is refused.
    expect(
      isRequestOriginAllowed('null', headers(`localhost:${PORT}`), []),
    ).toBe(false);
  });

  // A TLS-terminating front end (Cloud Run) serves the UI over https while the
  // container sees a plain-http Host, so the same-origin check must compare
  // authorities, not full URLs including the scheme.
  it('allows an https Origin whose authority matches the Host', () => {
    expect(
      isRequestOriginAllowed(
        'https://svc.a.run.app',
        headers('svc.a.run.app'),
        [],
      ),
    ).toBe(true);
  });

  it('blocks an Origin whose authority differs from the Host', () => {
    expect(
      isRequestOriginAllowed(
        'https://other.a.run.app',
        headers('svc.a.run.app'),
        [],
      ),
    ).toBe(false);
  });

  it('allows an origin configured with a trailing slash once normalized', () => {
    expect(
      isRequestOriginAllowed(
        'http://localhost:4200',
        headers(`localhost:${PORT}`),
        parseAllowedOrigins('http://localhost:4200/').origins,
      ),
    ).toBe(true);
  });
});
