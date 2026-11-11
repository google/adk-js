/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthScheme, OAuth2Auth} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthorizationCodeParams,
  ClientCredentialsParams,
  createOAuth2TokenRequestBody,
  createS256CodeChallenge,
  fetchOAuth2Tokens,
  generateCodeVerifier,
  getTokenEndpoint,
  isTokenExpired,
  parseAuthorizationCode,
  RefreshTokenParams,
} from '../../../src/auth/oauth2/oauth2_utils.js';
import {
  createHash as shimCreateHash,
  randomBytes as shimRandomBytes,
} from '../../../src/utils/crypto_shim.js';

describe('oauth2_utils', () => {
  describe('getTokenEndpoint', () => {
    it('returns tokenEndpoint from OpenIdConnectWithConfig', () => {
      const scheme = {
        type: 'openIdConnect',
        tokenEndpoint: 'https://example.com/token',
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBe('https://example.com/token');
    });

    it('returns tokenUrl from flows.authorizationCode', () => {
      const scheme = {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            tokenUrl: 'https://example.com/token-auth',
          },
        },
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBe('https://example.com/token-auth');
    });

    it('returns tokenUrl from flows.clientCredentials', () => {
      const scheme = {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://example.com/token-cc',
          },
        },
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBe('https://example.com/token-cc');
    });

    it('returns undefined if no token URIs are found', () => {
      const scheme = {
        flows: {
          implicit: {
            authorizationUrl: 'https://example.com/auth',
          },
        },
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBeUndefined();
    });

    it('returns undefined if flows is empty', () => {
      const scheme = {
        flows: {},
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBeUndefined();
    });
  });

  describe('fetchOAuth2Tokens', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('fetches tokens successfully and maps snake_case to camelCase', async () => {
      const mockResponse = {
        access_token: 'acc-123',
        refresh_token: 'ref-456',
        expires_in: 3600,
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const body = new URLSearchParams();
      const result = await fetchOAuth2Tokens('https://example.com/token', body);

      expect(result.accessToken).toBe('acc-123');
      expect(result.refreshToken).toBe('ref-456');
      expect(result.expiresIn).toBe(3600);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it('handles missing refresh_token or expires_in', async () => {
      const mockResponse = {
        access_token: 'acc-123',
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const body = new URLSearchParams();
      const result = await fetchOAuth2Tokens('https://example.com/token', body);

      expect(result.accessToken).toBe('acc-123');
      expect(result.refreshToken).toBeUndefined();
      expect(result.expiresIn).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });

    it('throws error if response is not ok', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      const body = new URLSearchParams();
      await expect(
        fetchOAuth2Tokens('https://example.com/token', body),
      ).rejects.toThrow('Token request failed with status 401');
    });

    it('does not follow redirects (redirect: error) to prevent SSRF credential leaks', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({access_token: 'acc-123'}),
      } as Response);

      await fetchOAuth2Tokens(
        'https://example.com/token',
        new URLSearchParams(),
      );

      // The blocklist only validates the initial endpoint, so redirects must
      // not be followed or the credential-bearing POST could be redirected to
      // a private/cloud-metadata address.
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/token',
        expect.objectContaining({redirect: 'error'}),
      );
    });

    it('propagates the error when the endpoint attempts a redirect', async () => {
      // With redirect: 'error', the runtime's fetch rejects on any 3xx.
      vi.mocked(fetch).mockRejectedValue(
        new TypeError('fetch failed: unexpected redirect'),
      );

      await expect(
        fetchOAuth2Tokens('https://example.com/token', new URLSearchParams()),
      ).rejects.toThrow();
    });

    it('rejects a token endpoint that targets a blocked host before any fetch', async () => {
      await expect(
        fetchOAuth2Tokens(
          'https://169.254.169.254/token',
          new URLSearchParams(),
        ),
      ).rejects.toThrow('SSRF protection');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('parseAuthorizationCode', () => {
    it('parses code from query string', () => {
      const uri = 'https://example.com/callback?code=super-secret&state=abc';
      expect(parseAuthorizationCode(uri)).toBe('super-secret');
    });

    it('returns undefined if code is missing', () => {
      const uri = 'https://example.com/callback?state=abc';
      expect(parseAuthorizationCode(uri)).toBeUndefined();
    });

    it('returns undefined and logs warning for invalid URI', () => {
      const uri = 'not-a-valid-url';
      expect(parseAuthorizationCode(uri)).toBeUndefined();
    });
  });

  describe('createOAuth2TokenRequestBody', () => {
    it('creates body for client_credentials', () => {
      const params: ClientCredentialsParams = {
        grantType: 'client_credentials',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      };

      const body = createOAuth2TokenRequestBody(params);

      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
    });

    it('creates body for authorization_code', () => {
      const params: AuthorizationCodeParams = {
        grantType: 'authorization_code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'auth-code',
        redirectUri: 'https://example.com/callback',
      };

      const body = createOAuth2TokenRequestBody(params);

      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('redirect_uri')).toBe('https://example.com/callback');
    });

    it('creates body for authorization_code with code_verifier', () => {
      const params: AuthorizationCodeParams = {
        grantType: 'authorization_code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'auth-code',
        redirectUri: 'https://example.com/callback',
        codeVerifier: 'verifier-123',
      };

      const body = createOAuth2TokenRequestBody(params);

      expect(body.get('code_verifier')).toBe('verifier-123');
    });

    it('creates body for refresh_token', () => {
      const params: RefreshTokenParams = {
        grantType: 'refresh_token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      };

      const body = createOAuth2TokenRequestBody(params);

      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
      expect(body.get('refresh_token')).toBe('refresh-token');
    });
  });

  describe('isTokenExpired', () => {
    it('returns false if expiresAt is not a number', () => {
      expect(isTokenExpired({} as unknown as OAuth2Auth)).toBe(false);
      expect(
        isTokenExpired({expiresAt: 'not-a-number'} as unknown as OAuth2Auth),
      ).toBe(false);
    });

    it('returns false if token is not expired (future expiresAt in milliseconds)', () => {
      const futureTimeMs = Date.now() + 3600 * 1000; // 1 hour in future
      expect(isTokenExpired({expiresAt: futureTimeMs} as OAuth2Auth)).toBe(
        false,
      );
    });

    it('returns true if token is expired (past expiresAt in milliseconds)', () => {
      const pastTimeMs = Date.now() - 3600 * 1000; // 1 hour in past
      expect(isTokenExpired({expiresAt: pastTimeMs} as OAuth2Auth)).toBe(true);
    });

    it('uses leeway (default 60s)', () => {
      const nearFutureTimeMs = Date.now() + 30 * 1000; // 30s in future
      // With 60s leeway, 30s should be considered expired
      expect(isTokenExpired({expiresAt: nearFutureTimeMs} as OAuth2Auth)).toBe(
        true,
      );
    });
  });

  describe('createS256CodeChallenge', () => {
    it('matches the published SHA-256 vector for "abc"', () => {
      expect(createS256CodeChallenge('abc')).toBe(
        'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
      );
    });

    it('encodes base64url, so no "+", "/" or "=" survives', () => {
      // The standard base64 digest of 'v2' is
      // '+wTctpcOTD0Yc95R/VpQ17tGszgxE2AmZcNQ7EC1+ZA=', which carries all
      // three characters RFC 7636 forbids in a code challenge.
      const challenge = createS256CodeChallenge('v2');

      expect(challenge).toBe('-wTctpcOTD0Yc95R_VpQ17tGszgxE2AmZcNQ7EC1-ZA');
      expect(challenge).not.toMatch(/[+/=]/);
    });

    it('returns the 43 characters a SHA-256 digest encodes to', () => {
      expect(createS256CodeChallenge(generateCodeVerifier())).toHaveLength(43);
    });
  });

  describe('generateCodeVerifier', () => {
    it('returns 48 unreserved characters', () => {
      const verifier = generateCodeVerifier();

      expect(verifier).toHaveLength(48);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });

    it('does not repeat itself across calls', () => {
      const verifiers = new Set(
        Array.from({length: 1000}, () => generateCodeVerifier()),
      );

      expect(verifiers.size).toBe(1000);
    });
  });

  // The web build aliases node:crypto to this shim, so it stands in for the
  // PKCE helpers above in a browser, where no synchronous SHA-256 exists.
  describe('crypto_shim', () => {
    it('throws instead of degrading when hashing a code verifier', () => {
      expect(() => shimCreateHash('sha256')).toThrow(
        /require a synchronous SHA-256/,
      );
    });

    it('throws instead of degrading when generating a code verifier', () => {
      expect(() => shimRandomBytes(36)).toThrow(
        /no cryptographically secure source of randomness/,
      );
    });
  });
});
