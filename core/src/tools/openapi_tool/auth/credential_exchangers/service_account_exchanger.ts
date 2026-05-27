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
} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

/**
 * Fetches credentials for Google Service Account.
 * Ported from Python implementation.
 */
@experimental
export class ServiceAccountCredentialExchanger implements BaseCredentialExchanger {
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential} = params;

    if (
      authCredential.authType !== AuthCredentialTypes.SERVICE_ACCOUNT ||
      !authCredential.serviceAccount
    ) {
      throw new CredentialExchangeError(
        'Invalid credential type for ServiceAccountCredentialExchanger',
      );
    }

    const saConfig = authCredential.serviceAccount;

    if (saConfig.useDefaultCredential) {
      return this.exchangeForDefaultCredential(saConfig);
    }

    return this.exchangeForExplicitCredential(saConfig);
  }

  private async exchangeForDefaultCredential(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    try {
      const auth = new GoogleAuth({
        scopes: saConfig.scopes || DEFAULT_SCOPES,
      });
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      const token = tokenResponse.token;

      if (!token) {
        throw new Error('Failed to get access token from default credentials');
      }

      return {
        credential: {
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'bearer',
            credentials: {token},
          },
        },
        wasExchanged: true,
      };
    } catch (error) {
      throw new CredentialExchangeError(
        `Failed to exchange default service account token: ${(error as Error).message}`,
      );
    }
  }

  private async exchangeForExplicitCredential(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    const creds = saConfig.serviceAccountCredential;
    if (!creds) {
      throw new CredentialExchangeError(
        'Service account credentials are missing.',
      );
    }

    try {
      const client = new JWT({
        email: creds.clientEmail,
        key: creds.privateKey,
        scopes: saConfig.scopes,
      });

      const tokens = await client.authorize();
      const token = tokens.access_token;

      if (!token) {
        throw new Error('Failed to get access token from explicit credentials');
      }

      return {
        credential: {
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'bearer',
            credentials: {token},
          },
        },
        wasExchanged: true,
      };
    } catch (error) {
      throw new CredentialExchangeError(
        `Failed to exchange explicit service account token: ${(error as Error).message}`,
      );
    }
  }
}
