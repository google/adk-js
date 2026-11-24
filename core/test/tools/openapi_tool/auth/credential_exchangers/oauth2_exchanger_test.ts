/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/tools/openapi_tool/auth/credential_exchangers/test_oauth2_exchanger.py`
 * at tag `v0.2.0`. The reference implementation is pinned at `v0.1.0`, which
 * ships no `tests/` directory; the implementation file is byte-identical at the
 * two tags, so the `v0.2.0` tests describe the `v0.1.0` shape.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  exchangeCredential,
  generateAuthToken as generateAuthTokenFromPackage,
  OpenIdConnectWithConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
// `checkSchemeCredentialType` is an internal of `exchangeCredential` and is not
// on the package surface. The package export of `generateAuthToken` is covered
// by its own block at the end of this file.
import {
  checkSchemeCredentialType,
  generateAuthToken,
} from '../../../../../src/tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.js';

const authScheme: OpenIdConnectWithConfig = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://example.com/auth',
  tokenEndpoint: 'https://example.com/token',
  scopes: ['openid', 'profile'],
};

function oauth2Credential(oauth2: AuthCredential['oauth2']): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

describe('OAuth2BearerExchanger ported reference tests', () => {
  // test_check_scheme_credential_type_success
  it('accepts a valid OpenID Connect scheme and OAuth2 credential', () => {
    const authCredential = oauth2Credential({
      clientId: 'test_client',
      clientSecret: 'test_secret',
      redirectUri: 'http://localhost:8080',
    });

    expect(() =>
      checkSchemeCredentialType(authScheme, authCredential),
    ).not.toThrow();
  });

  // test_check_scheme_credential_type_missing_credential
  it('throws when authCredential is undefined', () => {
    expect(() => checkSchemeCredentialType(authScheme, undefined)).toThrow(
      'authCredential is empty',
    );
  });

  // The TYPE. Every other assertion here pins the message, so the error class
  // could be swapped for `CredentialExchangeError` -- which it was, twice --
  // without a test failing. The reference raises `ValueError`, and this port's
  // rule turns a Python-only error type into a plain `Error`.
  it('throws a plain Error, as the ValueError rule requires', () => {
    let thrown: unknown;
    try {
      checkSchemeCredentialType(authScheme, undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).constructor).toBe(Error);
  });

  // test_check_scheme_credential_type_invalid_scheme_type
  it('throws when the security scheme is not OAuth2 or OpenID Connect', () => {
    // Python builds the invalid scheme with `AuthSchemeType.apiKey`. adk-js has
    // no such enum, so the openapi-types literal `'apiKey'` stands in.
    const invalidScheme: AuthScheme = {
      type: 'apiKey',
      name: 'k',
      in: 'header',
    };
    const authCredential = oauth2Credential({
      clientId: 'test_client',
      clientSecret: 'test_secret',
      redirectUri: 'http://localhost:8080',
    });

    expect(() =>
      checkSchemeCredentialType(invalidScheme, authCredential),
    ).toThrow('Invalid security scheme');
  });

  // test_check_scheme_credential_type_missing_openid_connect
  it('throws when the credential is missing oauth2 configuration', () => {
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
    };

    expect(() => checkSchemeCredentialType(authScheme, authCredential)).toThrow(
      'authCredential is not configured with oauth2',
    );
  });

  // test_generate_auth_token_success
  it('converts an OAuth2 access token into an HTTP bearer credential', () => {
    // Divergence: Python passes `token={"access_token": "test_access_token"}`.
    // adk-python commit 956fb912e replaced that dict with top-level
    // `access_token` and `refresh_token`, and adk-js only ever shipped the
    // post-break shape, so the fixture sets `accessToken`.
    const authCredential = oauth2Credential({
      clientId: 'test_client',
      clientSecret: 'test_secret',
      redirectUri: 'http://localhost:8080',
      authResponseUri: 'https://example.com/callback?code=test_code',
      accessToken: 'test_access_token',
    });

    const updatedCredential = generateAuthToken(authCredential);

    expect(updatedCredential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(updatedCredential.http?.scheme).toBe('bearer');
    expect(updatedCredential.http?.credentials.token).toBe('test_access_token');
  });

  // test_exchange_credential_generate_auth_token
  it('exchanges a valid OAuth2 credential with an access token into a bearer credential', () => {
    // Same fixture divergence as above, for the same reason.
    const authCredential = oauth2Credential({
      clientId: 'test_client',
      clientSecret: 'test_secret',
      redirectUri: 'http://localhost:8080',
      authResponseUri: 'https://example.com/callback?code=test_code',
      accessToken: 'test_access_token',
    });

    const updatedCredential = exchangeCredential(authScheme, authCredential);

    expect(updatedCredential?.authType).toBe(AuthCredentialTypes.HTTP);
    expect(updatedCredential?.http?.scheme).toBe('bearer');
    expect(updatedCredential?.http?.credentials.token).toBe(
      'test_access_token',
    );
  });

  // test_exchange_credential_refresh_token_only
  it('returns null when the credential has only a refresh token', () => {
    const authCredential = oauth2Credential({
      clientId: 'test_client',
      clientSecret: 'test_secret',
      redirectUri: 'http://localhost:8080',
      refreshToken: 'test_refresh_token',
    });

    const updatedCredential = exchangeCredential(authScheme, authCredential);

    expect(updatedCredential).toBeNull();
  });

  // test_exchange_credential_auth_missing
  it('throws when exchangeCredential is called without authCredential', () => {
    expect(() => exchangeCredential(authScheme, undefined)).toThrow(
      'authCredential is empty. Please create AuthCredential using',
    );
  });
});

describe('generateAuthToken package export', () => {
  it('converts an access token into an HTTP bearer credential', () => {
    const authCredential = oauth2Credential({accessToken: 'package-token'});

    expect(generateAuthTokenFromPackage(authCredential)).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'package-token'}},
    });
  });

  it('returns the credential itself when it holds no access token', () => {
    const authCredential = oauth2Credential({refreshToken: 'refresh-token'});

    expect(generateAuthTokenFromPackage(authCredential)).toBe(authCredential);
  });

  it('is the same function the exchanger module defines', () => {
    expect(generateAuthTokenFromPackage).toBe(generateAuthToken);
  });
});
