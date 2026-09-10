/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  getAllowedRequestHosts,
  isDnsRebindingRequest,
  isLoopbackAddress,
} from '../../src/server/dns_rebinding_guard.js';

describe('isLoopbackAddress', () => {
  it('accepts localhost, with and without a port', () => {
    expect(isLoopbackAddress('localhost')).toBe(true);
    expect(isLoopbackAddress('localhost:8000')).toBe(true);
    expect(isLoopbackAddress('LOCALHOST:8000')).toBe(true);
    expect(isLoopbackAddress('localhost.:8000')).toBe(true);
  });

  it('accepts the 127.0.0.0/8 range, with and without a port', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.1:8000')).toBe(true);
    expect(isLoopbackAddress('127.0.0.2:8000')).toBe(true);
    expect(isLoopbackAddress('127.000.000.001:8000')).toBe(true);
  });

  it('accepts ::1, bracketed, with and without a port', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('[::1]:8000')).toBe(true);
  });

  it('rejects a dotted-quad payload disguised with a fake port suffix', () => {
    // The exact bug this guard exists to close: a malformed authority must
    // come back whole from stripPort, not read as loopback.
    expect(isLoopbackAddress('127.0.0.1:8000.evil.com')).toBe(false);
    expect(isLoopbackAddress('127.0.0.1:evil.com')).toBe(false);
  });

  it('rejects a bracketed host with a non-port suffix', () => {
    expect(isLoopbackAddress('[::1]x:8000')).toBe(false);
    expect(isLoopbackAddress('[evil.attacker.example]')).toBe(false);
  });

  it('rejects a bracketed host with no closing bracket', () => {
    expect(isLoopbackAddress('[::1')).toBe(false);
  });

  it('rejects a non-loopback host', () => {
    expect(isLoopbackAddress('evil.attacker.example')).toBe(false);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('127.0.0.256')).toBe(false); // out of range octet
  });
});

describe('getAllowedRequestHosts', () => {
  it('vouches for the hostname of a real configured origin', () => {
    const hosts = getAllowedRequestHosts('http://proxy.example');
    expect(hosts).toEqual(new Set(['proxy.example']));
  });

  it('disables the guard entirely for a wildcard origin', () => {
    expect(getAllowedRequestHosts('*')).toBeNull();
  });

  it('vouches for no host on a malformed origin', () => {
    expect(getAllowedRequestHosts('not a valid url')).toEqual(new Set());
  });

  it('vouches for no host when allowOrigins is unset', () => {
    expect(getAllowedRequestHosts(undefined)).toEqual(new Set());
  });

  it('merges extraAllowedHosts with the origin-derived host', () => {
    const hosts = getAllowedRequestHosts('http://proxy.example', [
      'Other.Example',
      '  padded.example  ',
    ]);
    expect(hosts).toEqual(
      new Set(['proxy.example', 'other.example', 'padded.example']),
    );
  });

  it('accepts extraAllowedHosts with no allowOrigins set at all', () => {
    const hosts = getAllowedRequestHosts(undefined, ['proxy.example']);
    expect(hosts).toEqual(new Set(['proxy.example']));
  });

  it('ignores empty/whitespace-only entries in extraAllowedHosts', () => {
    const hosts = getAllowedRequestHosts(undefined, ['', '   ']);
    expect(hosts).toEqual(new Set());
  });

  it('still disables the guard for "*" even with extraAllowedHosts set', () => {
    expect(getAllowedRequestHosts('*', ['proxy.example'])).toBeNull();
  });
});

describe('isDnsRebindingRequest', () => {
  const LOOPBACK_BIND = 'localhost';
  const NON_LOOPBACK_BIND = '0.0.0.0';

  it('never rejects when the guard is disabled (null allowedRequestHosts)', () => {
    expect(
      isDnsRebindingRequest('evil.attacker.example', LOOPBACK_BIND, null),
    ).toBe(false);
  });

  it('never rejects when the server is not bound to loopback', () => {
    // The guard's entire premise is a loopback bind being reachable from
    // an attacker-controlled hostname; a non-loopback bind is already
    // reachable by design, so there is nothing for the guard to protect.
    expect(
      isDnsRebindingRequest(
        'evil.attacker.example',
        NON_LOOPBACK_BIND,
        new Set(),
      ),
    ).toBe(false);
  });

  it('never rejects an absent Host header', () => {
    // Browsers always send Host; its absence is not a rebinding vector,
    // and rejecting it would just break non-browser callers for nothing.
    expect(isDnsRebindingRequest(undefined, LOOPBACK_BIND, new Set())).toBe(
      false,
    );
  });

  it('rejects a Host header containing a comma', () => {
    // Host is a singleton header; more than one value reaching this point
    // is a smuggling attempt, not something a normal client produces.
    expect(
      isDnsRebindingRequest(
        'evil.attacker.example,localhost',
        LOOPBACK_BIND,
        new Set(),
      ),
    ).toBe(true);
  });

  it('accepts a Host that resolves to loopback', () => {
    expect(
      isDnsRebindingRequest('127.0.0.1:8000', LOOPBACK_BIND, new Set()),
    ).toBe(false);
    expect(isDnsRebindingRequest('[::1]:8000', LOOPBACK_BIND, new Set())).toBe(
      false,
    );
  });

  it('accepts a Host explicitly present in allowedRequestHosts', () => {
    expect(
      isDnsRebindingRequest(
        'proxy.example',
        LOOPBACK_BIND,
        new Set(['proxy.example']),
      ),
    ).toBe(false);
  });

  it('rejects a Host that is neither loopback nor allow-listed', () => {
    expect(
      isDnsRebindingRequest('evil.attacker.example', LOOPBACK_BIND, new Set()),
    ).toBe(true);
  });

  it('rejects the disguised-loopback attack this guard exists for', () => {
    expect(
      isDnsRebindingRequest(
        '127.0.0.1:8000.evil.com',
        LOOPBACK_BIND,
        new Set(),
      ),
    ).toBe(true);
    expect(
      isDnsRebindingRequest('127.0.0.1:evil.com', LOOPBACK_BIND, new Set()),
    ).toBe(true);
  });
});
