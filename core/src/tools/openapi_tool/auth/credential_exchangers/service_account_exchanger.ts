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
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';
import {AuthCredentialMissingError} from './base_auth_credential_exchanger.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

const MISSING_SERVICE_ACCOUNT_CREDENTIALS =
  'Service account credentials are missing. Please provide them, or set ' +
  '`useDefaultCredential: true` to use application default credentials in a ' +
  'hosted service like Cloud Run.';

/**
 * Fetches credentials for Google Service Account.
 */
@experimental
export class ServiceAccountCredentialExchanger implements BaseCredentialExchanger {
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential} = params;

    // `serviceAccount` is the discriminator, not `authType`: adk-python never
    // reads the type, so a credential carrying key material is exchanged
    // whatever it announces.
    if (!authCredential.serviceAccount) {
      // One message for every missing-credential case, as the reference has
      // (`service_account_exchanger.py:60-67`): its single guard covers a null
      // credential, a null `service_account`, and both sub-fields unset, and it
      // never reads `auth_type`. Branching on the type produced a second string
      // -- "Invalid credential type for ..." -- with no counterpart there.
      throw new AuthCredentialMissingError(MISSING_SERVICE_ACCOUNT_CREDENTIALS);
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
      // The reference's catch-all raises `AuthCredentialMissingError`
      // (`service_account_exchanger.py:95`), not a distinct exchange-failure
      // type. A caller taught to catch it must not miss this path.
      throw new AuthCredentialMissingError(
        `Failed to exchange default service account token: ${(error as Error).message}`,
      );
    }
  }

  private async exchangeForExplicitCredential(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    const creds = saConfig.serviceAccountCredential;
    if (!creds) {
      // Same condition, same type as the check above: the reference raises
      // `AuthCredentialMissingError` for missing service-account material at
      // `service_account_exchanger.py:68`, and this is the explicit-credential
      // branch of it.
      throw new AuthCredentialMissingError(MISSING_SERVICE_ACCOUNT_CREDENTIALS);
    }

    try {
      // `tokenUri`, `authUri` and the certificate URLs have no counterpart on
      // the JWT client: google-auth-library hardcodes Google's token endpoint.
      const client = new JWT({
        email: creds.clientEmail,
        key: creds.privateKey,
        keyId: creds.privateKeyId,
        projectId: creds.projectId,
        universeDomain: creds.universeDomain,
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
      // As above: `service_account_exchanger.py:95` is the only catch-all in
      // the reference and it raises `AuthCredentialMissingError`.
      throw new AuthCredentialMissingError(
        `Failed to exchange explicit service account token: ${(error as Error).message}`,
      );
    }
  }
}
