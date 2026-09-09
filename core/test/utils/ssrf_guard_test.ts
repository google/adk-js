/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  isHttpUrl,
  isLinkLocalAddress,
  isNonGlobalAddress,
} from '../../src/utils/ssrf_guard.js';

describe('isHttpUrl', () => {
  it.each(['http://example.com/', 'https://example.com/'])(
    'accepts %s',
    (url) => {
      expect(isHttpUrl(new URL(url))).toBe(true);
    },
  );

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/card.json',
    'gopher://example.com/',
    'data:application/json,{}',
  ])('rejects %s', (url) => {
    expect(isHttpUrl(new URL(url))).toBe(false);
  });
});

describe('isLinkLocalAddress', () => {
  it.each([
    '169.254.169.254',
    '169.254.0.0',
    '169.254.255.255',
    'fe80::1',
    'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('reports %s as link-local', (address) => {
    expect(isLinkLocalAddress(address)).toBe(true);
  });

  it.each([
    '::ffff:169.254.169.254', // IPv4-mapped
    '64:ff9b::a9fe:a9fe', // NAT64 well-known prefix
    '2002:a9fe:a9fe::', // 6to4
    '::169.254.169.254', // IPv4-compatible
  ])('reports %s as link-local through its embedded IPv4', (address) => {
    expect(isLinkLocalAddress(address)).toBe(true);
  });

  it.each(['not-an-ip', '', '999.1.1.1', '169.254.1'])(
    'fails closed on the unparseable address %s',
    (address) => {
      expect(isLinkLocalAddress(address)).toBe(true);
    },
  );

  it.each([
    '169.253.0.1',
    '169.255.0.1',
    '8.8.8.8',
    '2606:4700:4700::1111',
    'fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fec0::1',
    '::ffff:8.8.8.8',
    '64:ff9b::8.8.8.8',
    '2002:808:808::',
  ])('reports %s as not link-local', (address) => {
    expect(isLinkLocalAddress(address)).toBe(false);
  });

  it.each(['127.0.0.1', '::1', '::', '10.0.0.5', '192.168.1.1'])(
    'allows %s, which this policy deliberately does not block',
    (address) => {
      expect(isLinkLocalAddress(address)).toBe(false);
    },
  );
});

describe('isNonGlobalAddress', () => {
  it.each([
    '64:ff9b::a9fe:a9fe', // NAT64 of the metadata endpoint
    '64:ff9b::7f00:1', // NAT64 of loopback
    '2002:7f00:1::', // 6to4 of loopback
    '::7f00:1', // IPv4-compatible loopback
    '::ffff:169.254.169.254', // IPv4-mapped
  ])('blocks %s, which embeds a non-global IPv4', (address) => {
    expect(isNonGlobalAddress(address)).toBe(true);
  });

  it.each([
    '64:ff9b::8.8.8.8',
    '2002:808:808::',
    '::ffff:8.8.8.8',
    '::fffe:7f00:1', // low 32 bits look like loopback, but this is not IPv4-compatible
  ])('allows %s, which embeds a global IPv4', (address) => {
    expect(isNonGlobalAddress(address)).toBe(false);
  });

  it.each([
    '::',
    '::1',
    '64:ff9b:1::1', // local NAT64 prefix, not the well-known one
    '127.0.0.1',
    '169.254.169.254',
    'fe80::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isNonGlobalAddress(address)).toBe(true);
  });
});
