/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of `oauth2_exchanger.ts` that the adk-python reference tests do not
 * cover: the `http` passthrough, the `null` return, the refresh-token-only
 * case, and the `exchange()` adapter.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  exchangeCredential,
  OAuth2BearerExchanger,
  OpenIdConnectWithConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
// `checkSchemeCredentialType` and `generateAuthToken` are internals of
// `exchangeCredential`, so they are not on the package surface.
import {
  checkSchemeCredentialType,
  generateAuthToken,
} from '../../../../../src/tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.js';

const openIdScheme: OpenIdConnectWithConfig = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://example.com/auth',
  tokenEndpoint: 'https://example.com/token',
  scopes: ['openid', 'profile'],
};

const oauth2Scheme: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: {profile: 'Read the profile'},
    },
  },
};

const bearerCredential: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'existing_bearer_token'}},
};

const accessTokenCredential: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'test_client', accessToken: 'test_access_token'},
};

const noTokenCredential: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'test_client', clientSecret: 'test_secret'},
};

describe('checkSchemeCredentialType', () => {
  it('accepts an oauth2 scheme', () => {
    expect(() =>
      checkSchemeCredentialType(oauth2Scheme, accessTokenCredential),
    ).not.toThrow();
  });
});

describe('exchangeCredential', () => {
  it('returns the same credential object when http is already set', () => {
    const result = exchangeCredential(openIdScheme, bearerCredential);

    expect(result).toBe(bearerCredential);
  });

  it('returns null when oauth2 carries no access or refresh token', () => {
    const result = exchangeCredential(openIdScheme, noTokenCredential);

    expect(result).toBeNull();
  });

  it('returns the original credential when only a refresh token is set', () => {
    const refreshOnlyCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'test_client', refreshToken: 'test_refresh_token'},
    };

    const result = exchangeCredential(openIdScheme, refreshOnlyCredential);

    expect(result).toBe(refreshOnlyCredential);
  });
});

describe('generateAuthToken', () => {
  it('returns the original credential when only a refresh token is set', () => {
    const refreshOnlyCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'test_client', refreshToken: 'test_refresh_token'},
    };

    const result = generateAuthToken(refreshOnlyCredential);

    expect(result).toBe(refreshOnlyCredential);
  });

  it('does not modify the credential it is given', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'test_client', accessToken: 'test_access_token'},
    };

    generateAuthToken(credential);

    expect(credential.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(credential.http).toBeUndefined();
    expect(credential.oauth2?.accessToken).toBe('test_access_token');
  });
});

describe('OAuth2BearerExchanger.exchange', () => {
  it('reports wasExchanged for a credential with an access token', async () => {
    const exchanger = new OAuth2BearerExchanger();

    const result = await exchanger.exchange({
      authScheme: openIdScheme,
      authCredential: accessTokenCredential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(result.credential.http?.credentials.token).toBe('test_access_token');
  });

  it('reports wasExchanged false for the http passthrough', async () => {
    const exchanger = new OAuth2BearerExchanger();

    const result = await exchanger.exchange({
      authScheme: openIdScheme,
      authCredential: bearerCredential,
    });

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toBe(bearerCredential);
  });

  it('reports wasExchanged false when there is no token to convert', async () => {
    const exchanger = new OAuth2BearerExchanger();

    const result = await exchanger.exchange({
      authScheme: openIdScheme,
      authCredential: noTokenCredential,
    });

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toBe(noTokenCredential);
  });

  it('rejects when authScheme is omitted', async () => {
    const exchanger = new OAuth2BearerExchanger();

    await expect(
      exchanger.exchange({authCredential: accessTokenCredential}),
    ).rejects.toThrow('authScheme is required');
  });
});
