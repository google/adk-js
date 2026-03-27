/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWT} from 'google-auth-library';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
} from '../auth_credential.js';
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

    if (saConfig.useIdToken) {
      return this._exchangeForIdToken(saConfig);
    }

    return this._exchangeForAccessToken(saConfig);
  }

  private async _exchangeForIdToken(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    if (!saConfig.useDefaultCredential && !saConfig.serviceAccountCredential) {
      throw new CredentialExchangeError(
        'serviceAccountCredential is required when useDefaultCredential is false',
      );
    }

    if (!saConfig.audience) {
      throw new CredentialExchangeError(
        'audience is required for ID token exchange',
      );
    }

    try {
      let auth: GoogleAuth;
      if (saConfig.useDefaultCredential) {
        auth = new GoogleAuth();
      } else {
        const creds = saConfig.serviceAccountCredential!;
        auth = new GoogleAuth({
          credentials: {
            client_email: creds.clientEmail,
            private_key: creds.privateKey,
          },
        });
      }

      const client = await auth.getIdTokenClient(saConfig.audience);
      const headers = await client.getRequestHeaders();
      const authHeader = headers.get('Authorization');
      if (!authHeader) {
        throw new CredentialExchangeError(
          'Failed to get authorization header for ID token',
        );
      }
      const token = authHeader.replace(/^Bearer /, '');

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
        `Failed to exchange service account for ID token: ${e.message || e}`,
      );
    }
  }

  private async _exchangeForAccessToken(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    if (!saConfig.useDefaultCredential && !saConfig.scopes) {
      throw new CredentialExchangeError(
        'scopes are required when using explicit service account credentials for access token exchange.',
      );
    }

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
        quotaProjectId = client.quotaProjectId;
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
          additionalHeaders: quotaProjectId
            ? {'x-goog-user-project': quotaProjectId}
            : undefined,
        },
      };

      return {
        credential: exchangedCredential,
        wasExchanged: true,
      };
    } catch (e: any) {
      throw new CredentialExchangeError(
        `Failed to exchange service account access token: ${e.message || e}`,
      );
    }
  }
}
