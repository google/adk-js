/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LookupAddress, LookupAllOptions} from 'node:dns';

import {FunctionTool, LOAD_WEB_PAGE, loadWebPage} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

/**
 * `lookup` is overloaded and its last overload resolves to a single
 * `LookupAddress`, so the mock is declared with the `{all: true}` signature the
 * implementation actually calls; `mockResolvedValue` then accepts the array.
 */
const {lookupMock} = vi.hoisted(() => ({
  lookupMock:
    vi.fn<
      (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>
    >(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

/**
 * Builds a response for the stubbed global `fetch`. The body is single-use, so
 * a test that fetches more than once must build a fresh one per call.
 */
function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {status});
}

/** Resolves any hostname to the given IP list for the DNS `lookup` mock. */
function resolveTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}

describe('loadWebPage', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      new AbortController().signal,
    );
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('scheme and hostname rejection (no network)', () => {
    it('rejects non-http(s) schemes without resolving or fetching', async () => {
      const result = await loadWebPage('file:///etc/passwd');

      expect(result).toBe('Failed to fetch url: file:///etc/passwd');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects malformed URLs', async () => {
      const result = await loadWebPage('not a url');

      expect(result).toBe('Failed to fetch url: not a url');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects the localhost hostname', async () => {
      const result = await loadWebPage('http://localhost:8080/');

      expect(result).toBe('Failed to fetch url: http://localhost:8080/');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects *.localhost hostnames', async () => {
      const result = await loadWebPage('http://api.localhost./');

      expect(result).toBe('Failed to fetch url: http://api.localhost./');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('SSRF IP rejection', () => {
    it('rejects loopback IPv4 literals without a DNS lookup', async () => {
      const url =
        'http://127.0.0.1:19876/latest/meta-data/iam/security-credentials/';

      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects shared address space (CGNAT) IPv4 literals', async () => {
      const result = await loadWebPage('http://100.64.0.1/internal');

      expect(result).toBe('Failed to fetch url: http://100.64.0.1/internal');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      'http://10.1.2.3/',
      'http://172.16.5.4/',
      'http://192.168.1.1/',
      'http://169.254.169.254/',
      'http://0.0.0.0/',
      'http://192.0.2.5/',
      'http://198.18.0.1/',
      'http://224.0.0.1/',
      'http://240.0.0.1/',
    ])('rejects non-global IPv4 literal %s', async (url) => {
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a private IP discovered via DNS resolution', async () => {
      resolveTo('169.254.169.254');

      const url = 'http://metadata.google.internal/computeMetadata/v1/';
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(lookupMock).toHaveBeenCalledWith('metadata.google.internal', {
        all: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects when any of several resolved addresses is non-global', async () => {
      resolveTo('93.184.216.34', '10.0.0.5');

      const result = await loadWebPage('http://mixed.example/');

      expect(result).toBe('Failed to fetch url: http://mixed.example/');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails closed when DNS resolves to an unparseable address', async () => {
      resolveTo('not-an-ip');

      const result = await loadWebPage('http://weird.example/');

      expect(result).toBe('Failed to fetch url: http://weird.example/');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails closed when DNS resolves to an out-of-range IPv4', async () => {
      resolveTo('1.2.3.999');

      const result = await loadWebPage('http://weird.example/');

      expect(result).toBe('Failed to fetch url: http://weird.example/');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails when DNS resolution returns no addresses', async () => {
      lookupMock.mockResolvedValue([]);

      const result = await loadWebPage('http://empty.example/');

      expect(result).toBe('Failed to fetch url: http://empty.example/');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails when DNS resolution throws', async () => {
      lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

      const result = await loadWebPage('http://missing.example/');

      expect(result).toBe('Failed to fetch url: http://missing.example/');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects IPv6 loopback literals', async () => {
      const result = await loadWebPage('http://[::1]/');

      expect(result).toBe('Failed to fetch url: http://[::1]/');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it.each([
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[ff02::1]/',
      'http://[2001:db8::1]/',
      'http://[::]/',
    ])('rejects non-global IPv6 literal %s', async (url) => {
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an IPv4-mapped IPv6 address pointing at a private IP', async () => {
      resolveTo('::ffff:127.0.0.1');

      const result = await loadWebPage('http://mapped.example/');

      expect(result).toBe('Failed to fetch url: http://mapped.example/');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('successful fetch and text extraction', () => {
    it('extracts readable text and drops short lines', async () => {
      resolveTo('93.184.216.34');
      fetchMock.mockResolvedValue(
        htmlResponse(
          '<html><body><p>This page has enough words to keep.</p>' +
            '<p>tiny</p></body></html>',
        ),
      );

      const result = await loadWebPage('https://example.com/search?q=adk');

      expect(result).toBe('This page has enough words to keep.');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestedUrl, init] = fetchMock.mock.calls[0];
      expect(requestedUrl).toBe('https://example.com/search?q=adk');
      expect(init).toMatchObject({redirect: 'manual'});
    });

    it('strips <script> and <style> blocks and decodes entities', async () => {
      resolveTo('93.184.216.34');
      fetchMock.mockResolvedValue(
        htmlResponse(
          '<html><head><style>.a{color:red}</style>' +
            '<script>var secret = "do not leak this";</script></head>' +
            '<body><!-- a comment that should vanish -->' +
            '<p>Fish &amp; chips are quite tasty today</p></body></html>',
        ),
      );

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Fish & chips are quite tasty today');
      expect(result).not.toContain('secret');
      expect(result).not.toContain('color:red');
      expect(result).not.toContain('comment');
    });

    it('allows a global IPv6 literal target', async () => {
      fetchMock.mockResolvedValue(
        htmlResponse('<p>The quick brown fox jumped over here</p>'),
      );

      const result = await loadWebPage('http://[2606:4700:4700::1111]/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('allows a global IPv6 address resolved via DNS (full form)', async () => {
      resolveTo('2606:4700:4700:0:0:0:0:1111');
      fetchMock.mockResolvedValue(
        htmlResponse('<p>The quick brown fox jumped over here</p>'),
      );

      const result = await loadWebPage('http://ipv6.example/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('allows an IPv4-mapped IPv6 address pointing at a public IP', async () => {
      resolveTo('::ffff:93.184.216.34');
      fetchMock.mockResolvedValue(
        htmlResponse('<p>The quick brown fox jumped over here</p>'),
      );

      const result = await loadWebPage('http://mapped-public.example/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns an empty string when no line has enough words', async () => {
      resolveTo('93.184.216.34');
      fetchMock.mockResolvedValue(htmlResponse('<p>too short</p>'));

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('');
    });
  });

  describe('response and transport failures', () => {
    it.each([301, 302, 404, 500])(
      'returns the failure string for non-200 status %i',
      async (status) => {
        resolveTo('93.184.216.34');
        fetchMock.mockResolvedValue(
          htmlResponse('<p>ignored body here</p>', status),
        );

        const result = await loadWebPage('https://example.com/');

        expect(result).toBe('Failed to fetch url: https://example.com/');
      },
    );

    it('returns the failure string when the request times out', async () => {
      resolveTo('93.184.216.34');
      fetchMock.mockRejectedValue(
        new DOMException('The operation timed out.', 'TimeoutError'),
      );

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });

    it('returns the failure string on a network error', async () => {
      resolveTo('93.184.216.34');
      fetchMock.mockRejectedValue(new TypeError('network failure'));

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });
  });

  describe('timeout configuration', () => {
    it('uses the 30s default and honors an override', async () => {
      resolveTo('93.184.216.34');
      // This test fetches twice, so each call needs its own unread body.
      fetchMock.mockImplementation(async () =>
        htmlResponse('<p>enough words to be kept here</p>'),
      );

      await loadWebPage('https://example.com/');
      expect(vi.mocked(AbortSignal.timeout)).toHaveBeenLastCalledWith(30_000);

      await loadWebPage('https://example.com/', {timeoutMs: 5000});
      expect(vi.mocked(AbortSignal.timeout)).toHaveBeenLastCalledWith(5000);
    });

    it('falls back to the default when options omit timeoutMs', async () => {
      resolveTo('93.184.216.34');
      fetchMock.mockResolvedValue(
        htmlResponse('<p>enough words to be kept here</p>'),
      );

      await loadWebPage('https://example.com/', {});

      expect(vi.mocked(AbortSignal.timeout)).toHaveBeenLastCalledWith(30_000);
    });
  });
});

describe('LOAD_WEB_PAGE tool', () => {
  it('is a FunctionTool exposing a load_web_page declaration', () => {
    expect(LOAD_WEB_PAGE).toBeInstanceOf(FunctionTool);

    const declaration = LOAD_WEB_PAGE._getDeclaration();
    expect(declaration?.name).toBe('load_web_page');
    expect(declaration?.parameters?.properties?.['url']).toBeDefined();
  });

  it('runs through the tool interface and returns the parity failure string', async () => {
    const result = await LOAD_WEB_PAGE.runAsync({
      args: {url: 'file:///etc/passwd'},
      toolContext: {} as never,
    });

    expect(result).toBe('Failed to fetch url: file:///etc/passwd');
  });
});
