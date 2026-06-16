/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {AuthCredential} from '../../../src/auth/auth_credential.js';
import {AuthScheme} from '../../../src/auth/auth_schemes.js';
import {OAuth2CredentialRefresher} from '../../../src/auth/oauth2/oauth2_credential_refresher.js';
import * as oauth2Utils from '../../../src/auth/oauth2/oauth2_utils.js';

vi.mock('../../../src/auth/oauth2/oauth2_utils.js', () => ({
  getTokenEndpoint: vi.fn(),
  fetchOAuth2Tokens: vi.fn(),
  isTokenExpired: vi.fn(),
}));

describe('OAuth2CredentialRefresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isRefreshNeeded', () => {
    it('returns false when the credential has no oauth2 field', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {} as AuthCredential;

      const result = await refresher.isRefreshNeeded(authCredential);

      expect(result).toBe(false);
      expect(oauth2Utils.isTokenExpired).not.toHaveBeenCalled();
    });

    it('returns false when oauth2 has no expiresAt', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {accessToken: 'existing-token'},
      } as AuthCredential;

      const result = await refresher.isRefreshNeeded(authCredential);

      expect(result).toBe(false);
      expect(oauth2Utils.isTokenExpired).not.toHaveBeenCalled();
    });

    it('returns false when the token is not expired', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {accessToken: 'existing-token', expiresAt: 123},
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(false);

      const result = await refresher.isRefreshNeeded(authCredential);

      expect(result).toBe(false);
      expect(oauth2Utils.isTokenExpired).toHaveBeenCalledWith(
        authCredential.oauth2,
      );
    });

    it('returns true when the token is expired', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {accessToken: 'existing-token', expiresAt: 123},
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);

      const result = await refresher.isRefreshNeeded(authCredential);

      expect(result).toBe(true);
      expect(oauth2Utils.isTokenExpired).toHaveBeenCalledWith(
        authCredential.oauth2,
      );
    });
  });

  describe('refresh', () => {
    const authScheme = {
      tokenEndpoint: 'https://example.com/token',
    } as AuthScheme;

    it('returns the original credential when there is no oauth2 field', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {} as AuthCredential;

      const result = await refresher.refresh(authCredential, authScheme);

      expect(result).toBe(authCredential);
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('returns the original credential when no auth scheme is provided', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {refreshToken: 'refresh-token'},
      } as AuthCredential;

      const result = await refresher.refresh(authCredential);

      expect(result).toBe(authCredential);
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('returns the original credential when no refresh token is available', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {accessToken: 'existing-token'},
      } as AuthCredential;

      const result = await refresher.refresh(authCredential, authScheme);

      expect(result).toBe(authCredential);
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('returns the original credential when refresh is not needed', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          refreshToken: 'refresh-token',
          expiresAt: 123,
        },
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(false);

      const result = await refresher.refresh(authCredential, authScheme);

      expect(result).toBe(authCredential);
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('returns the original credential when the token endpoint is missing', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          refreshToken: 'refresh-token',
          expiresAt: 123,
        },
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);
      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(undefined);

      const result = await refresher.refresh(authCredential, authScheme);

      expect(result).toBe(authCredential);
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('returns the original credential when clientId or clientSecret is missing', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {
          refreshToken: 'refresh-token',
          expiresAt: 123,
        },
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);
      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );

      const result = await refresher.refresh(authCredential, authScheme);

      expect(result).toBe(authCredential);
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('fetches new tokens and returns the updated credential when refresh is needed', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          accessToken: 'old-token',
          refreshToken: 'old-refresh-token',
          expiresAt: 123,
        },
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);
      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue({
        accessToken: 'new-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        expiresAt: 999,
      });

      const result = await refresher.refresh(authCredential, authScheme);

      expect(result).not.toBe(authCredential);
      expect(result.oauth2?.accessToken).toBe('new-token');
      expect(result.oauth2?.refreshToken).toBe('new-refresh-token');
      expect(result.oauth2?.expiresIn).toBe(3600);
      expect(result.oauth2?.expiresAt).toBe(999);
      expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalledTimes(1);
    });

    it('keeps the existing token values when the response omits them', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          accessToken: 'old-token',
          refreshToken: 'old-refresh-token',
          expiresAt: 123,
        },
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);
      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue({
        expiresIn: 3600,
      });

      const result = await refresher.refresh(authCredential, authScheme);

      expect(result.oauth2?.accessToken).toBe('old-token');
      expect(result.oauth2?.refreshToken).toBe('old-refresh-token');
      expect(result.oauth2?.expiresAt).toBe(123);
      expect(result.oauth2?.expiresIn).toBe(3600);
    });

    it('builds the request body with the refresh_token grant parameters', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'the-refresh-token',
          expiresAt: 123,
        },
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);
      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue({
        accessToken: 'new-token',
      });

      await refresher.refresh(authCredential, authScheme);

      expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalledTimes(1);
      const [endpoint, body] = vi.mocked(oauth2Utils.fetchOAuth2Tokens).mock
        .calls[0];
      expect(endpoint).toBe('https://example.com/token');
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('the-refresh-token');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
    });

    it('returns the original credential when fetching tokens fails', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          refreshToken: 'refresh-token',
          expiresAt: 123,
        },
      } as AuthCredential;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);
      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await refresher.refresh(authCredential, authScheme);

      expect(result).toBe(authCredential);
    });
  });
});
