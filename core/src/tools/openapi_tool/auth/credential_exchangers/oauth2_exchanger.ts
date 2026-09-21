/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';

/**
 * Validates that the scheme and the credential can produce a bearer token.
 *
 * @param authScheme - The OpenID Connect or OAuth2 auth scheme.
 * @param authCredential - The auth credential to validate.
 * @throws Error - If the credential is absent, the scheme is
 *     not OpenID Connect or OAuth2, or the credential carries neither `oauth2`
 *     nor `http`.
 */
export function checkSchemeCredentialType(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): asserts authCredential is AuthCredential {
  if (!authCredential) {
    throw new Error(
      'auth_credential is empty. Please create AuthCredential using OAuth2Auth.',
    );
  }

  // adk-python compares against `AuthSchemeType`; adk-js has no such enum.
  if (authScheme.type !== 'openIdConnect' && authScheme.type !== 'oauth2') {
    throw new Error(
      'Invalid security scheme, expect AuthSchemeType.openIdConnect or ' +
        `AuthSchemeType.oauth2 auth scheme, but got ${authScheme.type}`,
    );
  }

  if (!authCredential.oauth2 && !authCredential.http) {
    throw new Error(
      'auth_credential is not configured with oauth2. Please create AuthCredential and set OAuth2Auth.',
    );
  }
}

/**
 * Converts an OAuth2 access token into an HTTP bearer credential.
 *
 * @param authCredential - The auth credential holding the access token.
 * @returns A new credential holding the access token as an HTTP bearer token,
 *     or the original credential when there is no access token to convert. The
 *     input credential is never modified.
 */
export function generateAuthToken(
  authCredential: AuthCredential,
): AuthCredential {
  const accessToken = authCredential.oauth2?.accessToken;
  if (!accessToken) {
    return authCredential;
  }

  return {
    authType: AuthCredentialTypes.HTTP,
    http: {
      scheme: 'bearer',
      credentials: {token: accessToken},
    },
  };
}

/**
 * Exchanges an OAuth2 or OpenID Connect credential for an HTTP bearer one.
 *
 * @param authScheme - The auth scheme.
 * @param authCredential - The auth credential.
 * @returns The credential unchanged when it already carries `http`, a new HTTP
 *     bearer credential when it carries an access token, or `null` when there
 *     is no token to convert.
 * @throws Error - If the scheme or the credential is invalid.
 */
export function exchangeCredential(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): AuthCredential | null {
  checkSchemeCredentialType(authScheme, authCredential);

  // An HTTP bearer token is assumed to be still valid, so it passes through.
  if (authCredential.http) {
    return authCredential;
  }

  if (
    authCredential.oauth2?.accessToken ||
    authCredential.oauth2?.refreshToken
  ) {
    return generateAuthToken(authCredential);
  }

  return null;
}

/**
 * Converts OAuth2 and OpenID Connect credentials into HTTP bearer credentials.
 *
 * Ports `OAuth2CredentialExchanger` from adk-python
 * `src/google/adk/tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.py`
 * at tag `v0.1.0`. The adk-js class carries a different name because
 * `OAuth2CredentialExchanger` in `core/src/auth/oauth2/` already owns that one,
 * and it solves a different problem: it fetches tokens from the token endpoint,
 * where this class converts a token it is given.
 */
@experimental
export class OAuth2BearerExchanger implements BaseCredentialExchanger {
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authScheme, authCredential} = params;

    if (!authScheme) {
      throw new Error('authScheme is required for OAuth2 credential exchange');
    }

    const credential = exchangeCredential(authScheme, authCredential);

    return {
      credential: credential ?? authCredential,
      wasExchanged: credential !== null && credential !== authCredential,
    };
  }
}
