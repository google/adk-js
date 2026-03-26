/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
} from './base_credential_exchanger.js';

/**
 * Exchanges OAuth2 credentials from authorization responses using standard fetch.
 */
export class OAuth2CredentialExchanger implements BaseCredentialExchanger {
  /**
   * Exchange OAuth2 credential if needed.
   *
   * @param authCredential - The OAuth2 credential to exchange.
   * @param authScheme - The OAuth2 authentication scheme.
   * @returns The exchanged credential.
   * @throws CredentialExchangeError: If authScheme is missing.
   */
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
      }; // Already have access token
    }

    const grantType = this.determineGrantType(authScheme);

    if (grantType === OAuthGrantType.CLIENT_CREDENTIALS) {
      return this.exchangeClientCredentials({authCredential, authScheme});
    } else if (grantType === OAuthGrantType.AUTHORIZATION_CODE) {
      return this.exchangeAuthorizationCode({authCredential, authScheme});
    } else {
      console.warn(`Unsupported OAuth2 grant type: ${grantType}`);
      return {
        credential: authCredential,
        wasExchanged: false,
      };
    }
  }

  private determineGrantType(
    authScheme: AuthScheme,
  ): OAuthGrantType | undefined {
    if ('flows' in authScheme && authScheme.flows) {
      return getOAuthGrantTypeFromFlow(authScheme.flows);
    } else if ('grantTypesSupported' in authScheme) {
      const oidcScheme = authScheme as OpenIdConnectWithConfig;
      if (
        oidcScheme.grantTypesSupported &&
        oidcScheme.grantTypesSupported.includes('client_credentials')
      ) {
        return OAuthGrantType.CLIENT_CREDENTIALS;
      } else {
        return OAuthGrantType.AUTHORIZATION_CODE; // Default to authorization code for OIDC if not specified
      }
    }
    return undefined;
  }

  private async exchangeClientCredentials({
    authCredential,
    authScheme,
  }: {
    authCredential: AuthCredential;
    authScheme: AuthScheme;
  }): Promise<ExchangeResult> {
    const tokenEndpoint = this.getTokenEndpoint(authScheme);
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

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', authCredential.oauth2.clientId);
    body.set('client_secret', authCredential.oauth2.clientSecret);

    return {
      credential: await this.fetchTokens(tokenEndpoint, body, authCredential),
      wasExchanged: true,
    };
  }

  private async exchangeAuthorizationCode({
    authCredential,
    authScheme,
  }: {
    authCredential: AuthCredential;
    authScheme: AuthScheme;
  }): Promise<ExchangeResult> {
    const tokenEndpoint = this.getTokenEndpoint(authScheme);
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
      const url = new URL(authCredential.oauth2.authResponseUri);
      code = url.searchParams.get('code') || undefined;
    }

    if (!code) {
      throw new CredentialExchangeError(
        'Authorization code not found in auth response.',
      );
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', authCredential.oauth2.clientId);
    body.set('client_secret', authCredential.oauth2.clientSecret);
    body.set('code', code);
    if (authCredential.oauth2.redirectUri) {
      body.set('redirect_uri', authCredential.oauth2.redirectUri);
    }

    return {
      credential: await this.fetchTokens(tokenEndpoint, body, authCredential),
      wasExchanged: true,
    };
  }

  private getTokenEndpoint(authScheme: AuthScheme): string | undefined {
    if ('tokenEndpoint' in authScheme) {
      return (authScheme as OpenIdConnectWithConfig).tokenEndpoint;
    } else if ('flows' in authScheme && authScheme.flows) {
      const flows = authScheme.flows;
      const flow =
        flows.authorizationCode ||
        flows.clientCredentials ||
        flows.password ||
        flows.implicit; // Implicit doesn't typically have token endpoint in OpenApi but might have it
      if (flow && 'tokenUrl' in flow) {
        return flow.tokenUrl;
      }
    }
    return undefined;
  }

  private async fetchTokens(
    endpoint: string,
    body: URLSearchParams,
    authCredential: AuthCredential,
  ): Promise<AuthCredential> {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        throw new Error(`Token request failed with status ${response.status}`);
      }

      const data = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };

      const updatedOAuth2 = {
        ...authCredential.oauth2,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : undefined,
      };

      return {
        ...authCredential,
        oauth2: updatedOAuth2,
      };
    } catch (error) {
      console.error('Failed to fetch tokens:', error);
      throw new CredentialExchangeError(
        `Failed to exchange tokens: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
