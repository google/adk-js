/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWT} from 'google-auth-library';
import {AuthCredential, AuthCredentialTypes} from '../auth_credential.js';
import {AuthScheme} from '../auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from './base_credential_exchanger.js';

/**
 * Fetches credentials for Google Service Account.
 *
 * Uses the default service credential if `useDefaultCredential = true`.
 * Otherwise, uses the service account credential provided in the auth credential.
 */
export class ServiceAccountCredentialExchanger implements BaseCredentialExchanger {
  /**
   * Exchanges the service account auth credential for a token.
   */
  async exchange({
    authCredential,
    authScheme,
  }: {
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }): Promise<ExchangeResult> {
    if (!authCredential.serviceAccount) {
      throw new CredentialExchangeError(
        'Service account credentials are missing. Please provide them, or set `useDefaultCredential = true` to use application default credential.',
      );
    }

    const saConfig = authCredential.serviceAccount;

    // We take the scopes from the serviceAccount config, or use a default if available.
    // Defaults to 'https://www.googleapis.com/auth/cloud-platform' for default credentials if no scopes provided.
    const scopes =
      saConfig.scopes && saConfig.scopes.length > 0
        ? saConfig.scopes
        : ['https://www.googleapis.com/auth/cloud-platform'];

    try {
      let token: string | null | undefined = undefined;
      let quotaProjectId: string | null | undefined = undefined;

      if (saConfig.useDefaultCredential) {
        const auth = new GoogleAuth({
          scopes: scopes,
        });
        const client = await auth.getClient();
        const tokenResponse = await client.getAccessToken();
        token = tokenResponse.token;
        quotaProjectId = client.quotaProjectId; // Might be undefined
      } else {
        if (!saConfig.serviceAccountCredential) {
          throw new CredentialExchangeError(
            'serviceAccountCredential is required when useDefaultCredential is false',
          );
        }

        const creds = saConfig.serviceAccountCredential;
        const jwtClient = new JWT({
          email: creds.clientEmail,
          key: creds.privateKey,
          scopes: scopes,
        });

        const tokenResponse = await jwtClient.authorize();
        token = tokenResponse.access_token;
        // In JWT client, quotaProjectId might not be directly available as in GoogleAuth,
        // but it can be set if we want to extract it from the creds or if we don't need it.
      }

      if (!token) {
        throw new CredentialExchangeError(
          'Failed to get token from service account provider.',
        );
      }

      const exchangedCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {
            token,
          },
        },
      };

      return {
        credential: exchangedCredential,
        wasExchanged: true,
      };
    } catch (e: any) {
      throw new CredentialExchangeError(
        `Failed to exchange service account token: ${e.message || e}`,
      );
    }
  }
}
