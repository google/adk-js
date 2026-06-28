/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {AuthScheme} from '../../../src/auth/auth_schemes.js';
import {OAuth2CredentialRefresher} from '../../../src/auth/oauth2/oauth2_credential_refresher.js';
import * as oauth2Utils from '../../../src/auth/oauth2/oauth2_utils.js';

vi.mock('../../../src/auth/oauth2/oauth2_utils.js', () => ({
  fetchOAuth2Tokens: vi.fn(),
  getTokenEndpoint: vi.fn(),
  isTokenExpired: vi.fn(),
}));

describe('OAuth2CredentialRefresher', () => {
  describe('constructor', () => {
    it('can be instantiated', () => {
      const refresher = new OAuth2CredentialRefresher();
      expect(refresher).toBeInstanceOf(OAuth2CredentialRefresher);
    });
  });

  describe('isRefreshNeeded', () => {
    it('returns false when oauth2 field is absent', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
      };

      const result = await refresher.isRefreshNeeded(credential);

      expect(result).toBe(false);
      expect(oauth2Utils.isTokenExpired).not.toHaveBeenCalled();
    });

    it('returns false when oauth2 field is present but expiresAt is absent', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'some-token'},
      };

      const result = await refresher.isRefreshNeeded(credential);

      expect(result).toBe(false);
      expect(oauth2Utils.isTokenExpired).not.toHaveBeenCalled();
    });

    it('returns false when oauth2 has expiresAt and isTokenExpired returns false', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'some-token', expiresAt: Date.now() + 3600000},
      };

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(false);

      const result = await refresher.isRefreshNeeded(credential);

      expect(result).toBe(false);
      expect(oauth2Utils.isTokenExpired).toHaveBeenCalledWith(
        credential.oauth2,
      );
    });

    it('returns true when oauth2 has expiresAt and isTokenExpired returns true', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'some-token', expiresAt: Date.now() - 1000},
      };

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);

      const result = await refresher.isRefreshNeeded(credential);

      expect(result).toBe(true);
      expect(oauth2Utils.isTokenExpired).toHaveBeenCalledWith(
        credential.oauth2,
      );
    });
  });

  describe('refresh', () => {
    it('returns original credential when oauth2 field is absent', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
      };
      const authScheme = {} as AuthScheme;

      const result = await refresher.refresh(credential, authScheme);

      expect(result).toBe(credential);
    });

    it('returns original credential when authScheme is absent', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'token', refreshToken: 'rtoken'},
      };

      const result = await refresher.refresh(credential);

      expect(result).toBe(credential);
    });

    it('returns original credential when refreshToken is absent', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'token'},
      };
      const authScheme = {} as AuthScheme;

      const result = await refresher.refresh(credential, authScheme);

      expect(result).toBe(credential);
    });

    it('calls fetchOAuth2Tokens and returns updated credential on happy path', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const expiresAt = Date.now() - 1000;
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          accessToken: 'old-token',
          refreshToken: 'refresh-token',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          expiresAt,
        },
      };
      const authScheme = {
        type: 'oauth2',
        flows: {
          authorizationCode: {tokenUrl: 'https://example.com/token'},
        },
      } as unknown as AuthScheme;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);
      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue({
        accessToken: 'new-token',
        refreshToken: 'new-refresh',
        expiresIn: 3600,
        expiresAt: Date.now() + 3600000,
      });

      const result = await refresher.refresh(credential, authScheme);

      expect(result).not.toBe(credential);
      expect(result.oauth2?.accessToken).toBe('new-token');
      expect(result.oauth2?.refreshToken).toBe('new-refresh');
      expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalled();
    });

    it('returns original credential when fetchOAuth2Tokens throws', async () => {
      const refresher = new OAuth2CredentialRefresher();
      const expiresAt = Date.now() - 1000;
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          accessToken: 'old-token',
          refreshToken: 'refresh-token',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          expiresAt,
        },
      };
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.isTokenExpired).mockReturnValue(true);
      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await refresher.refresh(credential, authScheme);

      expect(result).toBe(credential);
    });
  });
});
