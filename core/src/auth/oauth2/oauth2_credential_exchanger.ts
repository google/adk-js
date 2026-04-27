/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';
import {AuthCredential} from '../auth_credential.js';
import {
  AuthScheme,
  getOAuthGrantTypeFromFlow,
  OAuthGrantType,
  OpenIdConnectWithConfig,
} from '../auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../exchanger/base_credential_exchanger.js';
import {
  createOAuth2TokenRequestBody,
  fetchOAuth2Tokens,
  getTokenEndpoint,
  parseAuthorizationCode,
} from './oauth2_utils.js';

/**
 * Exchanges OAuth2 credentials from authorization responses using standard fetch.
 */
export class OAuth2CredentialExchanger implements BaseCredentialExchanger {
  async exchange({
    authCredential,
    authScheme,
  }: {
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }): Promise<ExchangeResult> {
    if (!authScheme) {
      throw new CredentialExchangeError(
        'authScheme is required for OAuth2 credential exchange',
      );
    }

    if (authCredential.oauth2?.accessToken) {
      return {
        credential: authCredential,
        wasExchanged: false,
      };
    }

    const grantType = determineGrantType(authScheme);

    if (grantType === OAuthGrantType.CLIENT_CREDENTIALS) {
      return exchangeClientCredentials({authCredential, authScheme});
    }

    if (grantType === OAuthGrantType.AUTHORIZATION_CODE) {
      return exchangeAuthorizationCode({authCredential, authScheme});
    }

    logger.warn(`Unsupported OAuth2 grant type: ${grantType}`);
    return {
      credential: authCredential,
      wasExchanged: false,
    };
  }
}

export function determineGrantType(
  authScheme: AuthScheme,
): OAuthGrantType | undefined {
  if ('flows' in authScheme && authScheme.flows) {
    return getOAuthGrantTypeFromFlow(authScheme.flows);
  }

  if ((authScheme as OpenIdConnectWithConfig).grantTypesSupported) {
    const oidcScheme = authScheme as OpenIdConnectWithConfig;

    if (oidcScheme.grantTypesSupported?.includes('client_credentials')) {
      return OAuthGrantType.CLIENT_CREDENTIALS;
    }

    return OAuthGrantType.AUTHORIZATION_CODE;
  }
  return undefined;
}

export async function exchangeClientCredentials({
  authCredential,
  authScheme,
}: {
  authCredential: AuthCredential;
  authScheme: AuthScheme;
}): Promise<ExchangeResult> {
  const tokenEndpoint = getTokenEndpoint(authScheme);
  if (!tokenEndpoint) {
    throw new CredentialExchangeError(
      'Token endpoint not found in auth scheme.',
    );
  }

  if (
    !authCredential.oauth2?.clientId ||
    !authCredential.oauth2?.clientSecret
  ) {
    throw new CredentialExchangeError(
      'clientId and clientSecret are required for client credentials exchange.',
    );
  }

  const body = createOAuth2TokenRequestBody({
    grantType: 'client_credentials',
    clientId: authCredential.oauth2.clientId,
    clientSecret: authCredential.oauth2.clientSecret,
  });

  try {
    const oauth2Auth = await fetchOAuth2Tokens(tokenEndpoint, body);

    return {
      credential: {
        ...authCredential,
        oauth2: {
          ...authCredential.oauth2,
          ...oauth2Auth,
        },
      },
      wasExchanged: true,
    };
  } catch (error) {
    throw new CredentialExchangeError(
      `Failed to exchange tokens: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function exchangeAuthorizationCode({
  authCredential,
  authScheme,
}: {
  authCredential: AuthCredential;
  authScheme: AuthScheme;
}): Promise<ExchangeResult> {
  const tokenEndpoint = getTokenEndpoint(authScheme);
  if (!tokenEndpoint) {
    throw new CredentialExchangeError(
      'Token endpoint not found in auth scheme.',
    );
  }

  if (
    !authCredential.oauth2?.clientId ||
    !authCredential.oauth2?.clientSecret ||
    (!authCredential.oauth2?.authCode &&
      !authCredential.oauth2?.authResponseUri)
  ) {
    throw new CredentialExchangeError(
      'clientId, clientSecret, and either authCode or authResponseUri are required for authorization code exchange.',
    );
  }

  let code = authCredential.oauth2.authCode;
  if (!code && authCredential.oauth2.authResponseUri) {
    code = parseAuthorizationCode(authCredential.oauth2.authResponseUri);
  }

  if (authCredential.oauth2.authResponseUri && authCredential.oauth2.state) {
    try {
      const url = new URL(authCredential.oauth2.authResponseUri);
      const receivedState = url.searchParams.get('state') || undefined;
      if (authCredential.oauth2.state !== receivedState) {
        throw new CredentialExchangeError(
          'State mismatch detected. Potential CSRF attack.',
        );
      }
    } catch (e) {
      throw new CredentialExchangeError(
        `Failed to parse authResponseUri for state validation: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (!code) {
    throw new CredentialExchangeError(
      'Authorization code not found in auth response.',
    );
  }

  const body = createOAuth2TokenRequestBody({
    grantType: 'authorization_code',
    clientId: authCredential.oauth2.clientId,
    clientSecret: authCredential.oauth2.clientSecret,
    code,
    redirectUri: authCredential.oauth2.redirectUri,
    codeVerifier: authCredential.oauth2.codeVerifier,
  });

  try {
    const oauth2Auth = await fetchOAuth2Tokens(tokenEndpoint, body);

    return {
      credential: {
        ...authCredential,
        oauth2: {
          ...authCredential.oauth2,
          ...oauth2Auth,
        },
      },
      wasExchanged: true,
    };
  } catch (error: unknown) {
    throw new CredentialExchangeError(
      `Failed to exchange tokens: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
