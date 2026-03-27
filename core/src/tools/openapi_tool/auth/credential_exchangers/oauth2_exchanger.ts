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

/**
 * Fetches credentials for OAuth2 and OpenID Connect for the OpenAPI tool.
 *
 * This exchanger converts an OAuth2 access token into an HTTP Bearer token
 * for use by the OpenAPI client.
 */
export class OAuth2CredentialExchanger implements BaseCredentialExchanger {
  /**
   * Exchanges the OAuth2 credential if an access token is present.
   *
   * @param authCredential - The authentication credential.
   * @param authScheme - The authentication scheme.
   * @returns The exchanged credential result.
   */
  async exchange({
    authCredential,
    authScheme,
  }: {
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }): Promise<ExchangeResult> {
    if (!authCredential) {
      return {
        credential: authCredential,
        wasExchanged: false,
      };
    }

    // If it's already an HTTP bearer token, return it.
    if (authCredential.http) {
      return {
        credential: authCredential,
        wasExchanged: false,
      };
    }

    // If access token is present, convert it to a bearer token.
    if (authCredential.oauth2?.accessToken) {
      return {
        credential: {
          authType: AuthCredentialTypes.HTTP, // Store as bearer token
          http: {
            scheme: 'bearer',
            credentials: {
              token: authCredential.oauth2.accessToken,
            },
          },
        },
        wasExchanged: true,
      };
    }

    return {
      credential: authCredential,
      wasExchanged: false,
    };
  }
}
