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
 *
 * Every `it()` string keeps the Python test name verbatim so a reviewer can
 * grep the original.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  exchangeCredential,
  OpenIdConnectWithConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
// `checkSchemeCredentialType` and `generateAuthToken` are internals of
// `exchangeCredential`, so they are not on the package surface.
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
  it('test_check_scheme_credential_type_success', () => {
    const authCredential = oauth2Credential({
      clientId: 'test_client',
      clientSecret: 'test_secret',
      redirectUri: 'http://localhost:8080',
    });

    expect(() =>
      checkSchemeCredentialType(authScheme, authCredential),
    ).not.toThrow();
  });

  it('test_check_scheme_credential_type_missing_credential', () => {
    expect(() => checkSchemeCredentialType(authScheme, undefined)).toThrow(
      'auth_credential is empty',
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

  it('test_check_scheme_credential_type_invalid_scheme_type', () => {
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

  it('test_check_scheme_credential_type_missing_openid_connect', () => {
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
    };

    expect(() => checkSchemeCredentialType(authScheme, authCredential)).toThrow(
      'auth_credential is not configured with oauth2',
    );
  });

  it('test_generate_auth_token_success', () => {
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

  it('test_exchange_credential_generate_auth_token', () => {
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

  it('test_exchange_credential_auth_missing', () => {
    expect(() => exchangeCredential(authScheme, undefined)).toThrow(
      'auth_credential is empty. Please create AuthCredential using',
    );
  });
});
