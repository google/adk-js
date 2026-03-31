/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';
import {AuthCredential} from '../auth_credential.js';
import {AuthScheme} from '../auth_schemes.js';
import {BaseCredentialRefresher} from '../refresher/base_credential_refresher.js';
import {
  fetchOAuth2Tokens,
  getTokenEndpoint,
  isTokenExpired,
} from './oauth2_utils.js';

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

    if (authCredential.oauth2 && authCredential.oauth2.expiresAt) {
      return isTokenExpired(authCredential.oauth2);
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
      logger.warn('No refresh token available to refresh credential');
      return authCredential;
    }

    const isNeeded = await this.isRefreshNeeded(authCredential);
    if (!isNeeded) {
      return authCredential;
    }

    const tokenEndpoint = getTokenEndpoint(authScheme);
    if (!tokenEndpoint) {
      logger.warn('Token endpoint not found in auth scheme.');
      return authCredential;
    }

    if (
      !authCredential.oauth2.clientId ||
      !authCredential.oauth2.clientSecret
    ) {
      logger.warn('clientId and clientSecret are required for token refresh.');
      return authCredential;
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', authCredential.oauth2.refreshToken);
    body.set('client_id', authCredential.oauth2.clientId);
    body.set('client_secret', authCredential.oauth2.clientSecret);

    try {
      const data = await fetchOAuth2Tokens(tokenEndpoint, body);

      const updatedOAuth2 = {
        ...authCredential.oauth2,
        accessToken: data.accessToken || authCredential.oauth2.accessToken,
        refreshToken: data.refreshToken || authCredential.oauth2.refreshToken,
        expiresIn: data.expiresIn,
        expiresAt: data.expiresAt || authCredential.oauth2.expiresAt,
      };

      return {
        ...authCredential,
        oauth2: updatedOAuth2,
      };
    } catch (error) {
      logger.error('Failed to refresh tokens:', error);
      // Return original credential on failure, as per Python implementation
      return authCredential;
    }
  }
}
