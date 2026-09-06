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

  it('passes the wildcard and non-URL entries through unchanged', () => {
    expect(normalizeOrigin('*')).toBe('*');
    expect(normalizeOrigin('not a url')).toBe('not a url');
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
        [normalizeOrigin('http://localhost:4200/')],
      ),
    ).toBe(true);
  });
});
