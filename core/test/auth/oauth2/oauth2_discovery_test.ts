/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OAuth2DiscoveryManager} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('OAuth2DiscoveryManager', () => {
  let manager: OAuth2DiscoveryManager;

  beforeEach(() => {
    manager = new OAuth2DiscoveryManager();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('discoverAuthServerMetadata', () => {
    it('returns undefined and logs warning for invalid issuerUrl', async () => {
      const result = await manager.discoverAuthServerMetadata('not-a-url');
      expect(result).toBeUndefined();
    });

    it('returns undefined if issuerUrl uses non-https protocol', async () => {
      const result =
        await manager.discoverAuthServerMetadata('http://example.com');
      expect(result).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns undefined if issuerUrl uses private IP or localhost', async () => {
      const result =
        await manager.discoverAuthServerMetadata('https://127.0.0.1');
      expect(result).toBeUndefined();

      const result2 =
        await manager.discoverAuthServerMetadata('https://localhost');
      expect(result2).toBeUndefined();

      expect(fetch).not.toHaveBeenCalled();
    });

    it('tries endpoints in order if path is present', async () => {
      const issuerUrl = 'https://example.com/api';

      // Mock fetch to fail for all endpoints
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
      } as Response);

      await manager.discoverAuthServerMetadata(issuerUrl);

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'https://example.com/.well-known/oauth-authorization-server/api',
        expect.anything(),
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        'https://example.com/.well-known/openid-configuration/api',
        expect.anything(),
      );
      expect(fetch).toHaveBeenNthCalledWith(
        3,
        'https://example.com/api/.well-known/openid-configuration',
        expect.anything(),
      );
    });

    it('tries endpoints in order if path is not present or is root', async () => {
      const issuerUrl = 'https://example.com/';

      vi.mocked(fetch).mockResolvedValue({
        ok: false,
      } as Response);

      await manager.discoverAuthServerMetadata(issuerUrl);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'https://example.com/.well-known/oauth-authorization-server',
        expect.anything(),
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        'https://example.com/.well-known/openid-configuration',
        expect.anything(),
      );
    });

    it('returns metadata when discovery succeeds and issuer matches', async () => {
      const issuerUrl = 'https://example.com';
      const mockMetadata = {
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await manager.discoverAuthServerMetadata(issuerUrl);

      expect(result).toEqual(mockMetadata);
    });

    it('logs warning and returns undefined if issuer does not match', async () => {
      const issuerUrl = 'https://example.com';
      const mockMetadata = {
        issuer: 'https://malicious.com', // Fake issuer
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await manager.discoverAuthServerMetadata(issuerUrl);

      expect(result).toBeUndefined();
    });

    it('returns metadata when issuer matches even with trailing slash differences', async () => {
      const issuerUrl = 'https://example.com/';
      const mockMetadata = {
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await manager.discoverAuthServerMetadata(issuerUrl);

      expect(result).toEqual(mockMetadata);
    });

    it('rejects metadata if issuer is a subdomain of the expected issuer', async () => {
      const issuerUrl = 'https://example.com';
      const mockMetadata = {
        issuer: 'https://example.com.evil.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await manager.discoverAuthServerMetadata(issuerUrl);

      expect(result).toBeUndefined();
    });

    it('continues to next endpoint if fetch fails (throws error)', async () => {
      const issuerUrl = 'https://example.com';

      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            issuer: 'https://example.com',
            authorization_endpoint: 'https://example.com/authorize',
            token_endpoint: 'https://example.com/token',
          }),
        } as Response);

      const result = await manager.discoverAuthServerMetadata(issuerUrl);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toBeDefined();
    });

    it('continues to next endpoint if parsing fails', async () => {
      const issuerUrl = 'https://example.com';

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            invalid_field: 'broken',
          }),
        } as Response) // Fails validation
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            issuer: 'https://example.com',
            authorization_endpoint: 'https://example.com/authorize',
            token_endpoint: 'https://example.com/token',
          }),
        } as Response);

      const result = await manager.discoverAuthServerMetadata(issuerUrl);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toBeDefined();
    });
  });

  describe('discoverResourceMetadata', () => {
    it('returns undefined and logs warning for invalid resourceUrl', async () => {
      const result = await manager.discoverResourceMetadata('not-a-url');
      expect(result).toBeUndefined();
    });

    it('returns undefined if resourceUrl uses non-https protocol', async () => {
      const result =
        await manager.discoverResourceMetadata('http://example.com');
      expect(result).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns undefined if resourceUrl uses private IP or localhost', async () => {
      const result =
        await manager.discoverResourceMetadata('https://127.0.0.1');
      expect(result).toBeUndefined();

      const result2 =
        await manager.discoverResourceMetadata('https://localhost');
      expect(result2).toBeUndefined();

      expect(fetch).not.toHaveBeenCalled();
    });

    it('uses correct endpoint if path is present', async () => {
      const resourceUrl = 'https://example.com/api';

      vi.mocked(fetch).mockResolvedValue({
        ok: false,
      } as Response);

      await manager.discoverResourceMetadata(resourceUrl);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/.well-known/oauth-protected-resource/api',
        expect.anything(),
      );
    });

    it('uses correct endpoint if path is not present or is root', async () => {
      const resourceUrl = 'https://example.com/';

      vi.mocked(fetch).mockResolvedValue({
        ok: false,
      } as Response);

      await manager.discoverResourceMetadata(resourceUrl);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/.well-known/oauth-protected-resource',
        expect.anything(),
      );
    });

    it('returns metadata when discovery succeeds and resource matches', async () => {
      const resourceUrl = 'https://example.com';
      const mockMetadata = {
        resource: 'https://example.com',
        authorization_servers: ['https://example.com/auth'],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await manager.discoverResourceMetadata(resourceUrl);

      expect(result).toEqual(mockMetadata);
    });

    it('logs warning and returns undefined if resource does not match', async () => {
      const resourceUrl = 'https://example.com';
      const mockMetadata = {
        resource: 'https://malicious.com',
        authorization_servers: ['https://example.com/auth'],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await manager.discoverResourceMetadata(resourceUrl);

      expect(result).toBeUndefined();
    });

    it('returns metadata when resource matches even with trailing slash differences', async () => {
      const resourceUrl = 'https://example.com/';
      const mockMetadata = {
        resource: 'https://example.com',
        authorization_servers: ['https://example.com/auth'],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await manager.discoverResourceMetadata(resourceUrl);

      expect(result).toEqual(mockMetadata);
    });

    it('rejects metadata if resource is a subdomain of the expected resource', async () => {
      const resourceUrl = 'https://example.com';
      const mockMetadata = {
        resource: 'https://example.com.evil.com',
        authorization_servers: ['https://example.com/auth'],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await manager.discoverResourceMetadata(resourceUrl);

      expect(result).toBeUndefined();
    });

    it('returns undefined if fetch fails (throws error)', async () => {
      const resourceUrl = 'https://example.com';

      vi.mocked(fetch).mockRejectedValue(new Error('Network failure'));

      const result = await manager.discoverResourceMetadata(resourceUrl);

      expect(result).toBeUndefined();
    });

    it('returns undefined if parsing fails', async () => {
      const resourceUrl = 'https://example.com';

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          invalid_field: 'broken',
        }),
      } as Response);

      const result = await manager.discoverResourceMetadata(resourceUrl);

      expect(result).toBeUndefined();
    });
  });

  describe('validateDiscoveryUrl — SSRF blocklist', () => {
    async function isBlocked(url: string): Promise<boolean> {
      vi.mocked(fetch).mockClear();
      await manager.discoverAuthServerMetadata(url);
      return (fetch as ReturnType<typeof vi.fn>).mock.calls.length === 0;
    }
    it('blocks localhost', async () => {
      expect(await isBlocked('https://localhost/')).toBe(true);
    });
    it('blocks 127.0.0.1', async () => {
      expect(await isBlocked('https://127.0.0.1/')).toBe(true);
    });
    it('blocks [::1]', async () => {
      expect(await isBlocked('https://[::1]/')).toBe(true);
    });
    it('blocks 0.0.0.0', async () => {
      expect(await isBlocked('https://0.0.0.0/')).toBe(true);
    });
    it('blocks [::ffff:7f00:1] IPv4-mapped 127.0.0.1', async () => {
      expect(await isBlocked('https://[::ffff:7f00:1]/')).toBe(true);
    });
    it('blocks [::ffff:a9fe:a9fe] IPv4-mapped 169.254.169.254', async () => {
      expect(await isBlocked('https://[::ffff:a9fe:a9fe]/')).toBe(true);
    });
    it('blocks [::ffff:a00:1] IPv4-mapped 10.0.0.1', async () => {
      expect(await isBlocked('https://[::ffff:a00:1]/')).toBe(true);
    });
    it('blocks [::ffff:ac10:1] IPv4-mapped 172.16.0.1', async () => {
      expect(await isBlocked('https://[::ffff:ac10:1]/')).toBe(true);
    });
    it('blocks [::ffff:c0a8:101] IPv4-mapped 192.168.1.1', async () => {
      expect(await isBlocked('https://[::ffff:c0a8:101]/')).toBe(true);
    });
    it('blocks 10.0.0.1', async () => {
      expect(await isBlocked('https://10.0.0.1/')).toBe(true);
    });
    it('blocks 192.168.1.1', async () => {
      expect(await isBlocked('https://192.168.1.1/')).toBe(true);
    });
    it('blocks 169.254.169.254', async () => {
      expect(await isBlocked('https://169.254.169.254/')).toBe(true);
    });
    it('blocks 172.16.0.1', async () => {
      expect(await isBlocked('https://172.16.0.1/')).toBe(true);
    });
    it('blocks 172.31.0.1', async () => {
      expect(await isBlocked('https://172.31.0.1/')).toBe(true);
    });
    it('allows 172.15.0.1', async () => {
      expect(await isBlocked('https://172.15.0.1/')).toBe(false);
    });
    it('allows 172.32.0.1', async () => {
      expect(await isBlocked('https://172.32.0.1/')).toBe(false);
    });
    it('blocks 100.64.0.1 CGNAT', async () => {
      expect(await isBlocked('https://100.64.0.1/')).toBe(true);
    });
    it('blocks 100.127.0.1 CGNAT upper edge', async () => {
      expect(await isBlocked('https://100.127.0.1/')).toBe(true);
    });
    it('allows 100.63.0.1 below CGNAT', async () => {
      expect(await isBlocked('https://100.63.0.1/')).toBe(false);
    });
    it('blocks [fc00::1] IPv6 ULA', async () => {
      expect(await isBlocked('https://[fc00::1]/')).toBe(true);
    });
    it('blocks [fd00::1] IPv6 ULA fd::/8', async () => {
      expect(await isBlocked('https://[fd00::1]/')).toBe(true);
    });
    it('blocks [fdab:1234::1] IPv6 ULA fd::/8', async () => {
      expect(await isBlocked('https://[fdab:1234::1]/')).toBe(true);
    });
    it('blocks [fe80::1] IPv6 link-local', async () => {
      expect(await isBlocked('https://[fe80::1]/')).toBe(true);
    });
    it('blocks [febf::1] IPv6 link-local upper edge', async () => {
      expect(await isBlocked('https://[febf::1]/')).toBe(true);
    });
    it('allows accounts.google.com', async () => {
      expect(await isBlocked('https://accounts.google.com/')).toBe(false);
    });
    it('allows login.microsoftonline.com', async () => {
      expect(await isBlocked('https://login.microsoftonline.com/')).toBe(false);
    });
    it('blocks non-https scheme', async () => {
      expect(await isBlocked('http://example.com/')).toBe(true);
    });
  });
});
