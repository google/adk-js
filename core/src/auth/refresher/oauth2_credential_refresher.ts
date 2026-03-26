/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../auth_credential.js';
import {AuthScheme, OpenIdConnectWithConfig} from '../auth_schemes.js';
import {BaseCredentialRefresher} from './base_credential_refresher.js';

/**
 * Refreshes OAuth2 credentials using standard fetch.
 */
export class OAuth2CredentialRefresher implements BaseCredentialRefresher {
  /**
   * Check if the OAuth2 credential needs to be refreshed.
   *
   * @param authCredential The OAuth2 credential to check.
   * @param authScheme The OAuth2 authentication scheme (optional).
   * @returns True if the credential needs to be refreshed, False otherwise.
   */
  async isRefreshNeeded(authCredential: AuthCredential): Promise<boolean> {
    if (!authCredential.oauth2) {
      return false;
    }

    if (authCredential.oauth2.expiresAt) {
      // Buffer of 5 minutes to prevent edge cases
      const expirationBuffer = 5 * 60 * 1000;
      return Date.now() + expirationBuffer > authCredential.oauth2.expiresAt;
    }

    return false;
  }

  /**
   * Refresh the OAuth2 credential.
   *
   * @param authCredential The OAuth2 credential to refresh.
   * @param authScheme The OAuth2 authentication scheme.
   * @returns The refreshed credential.
   */
  async refresh(
    authCredential: AuthCredential,
    authScheme?: AuthScheme,
  ): Promise<AuthCredential> {
    if (!authCredential.oauth2 || !authScheme) {
      return authCredential;
    }

    if (!authCredential.oauth2.refreshToken) {
      console.warn('No refresh token available to refresh credential');
      return authCredential;
    }

    const isNeeded = await this.isRefreshNeeded(authCredential);
    if (!isNeeded) {
      return authCredential;
    }

    const tokenEndpoint = this.getTokenEndpoint(authScheme);
    if (!tokenEndpoint) {
      console.warn('Token endpoint not found in auth scheme.');
      return authCredential;
    }

    if (
      !authCredential.oauth2.clientId ||
      !authCredential.oauth2.clientSecret
    ) {
      console.warn('clientId and clientSecret are required for token refresh.');
      return authCredential;
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', authCredential.oauth2.refreshToken);
    body.set('client_id', authCredential.oauth2.clientId);
    body.set('client_secret', authCredential.oauth2.clientSecret);

    try {
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed with status ${response.status}`);
      }

      const data = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };

      const updatedOAuth2 = {
        ...authCredential.oauth2,
        accessToken: data.access_token || authCredential.oauth2.accessToken,
        refreshToken: data.refresh_token || authCredential.oauth2.refreshToken,
        expiresIn: data.expires_in,
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : authCredential.oauth2.expiresAt,
      };

      return {
        ...authCredential,
        oauth2: updatedOAuth2,
      };
    } catch (error) {
      console.error('Failed to refresh tokens:', error);
      // Return original credential on failure, as per Python implementation
      return authCredential;
    }
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
        flows.implicit;
      if (flow && 'tokenUrl' in flow) {
        return flow.tokenUrl;
      }
    }
    return undefined;
  }
}
