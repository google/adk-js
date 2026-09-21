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
import {OAuth2CredentialExchanger} from '../../../../auth/oauth2/oauth2_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';
import {ServiceAccountCredentialExchanger} from './service_account_exchanger.js';

/**
 * A map from auth credential type to the exchanger that handles it, merged
 * over the built-in defaults.
 */
export type CustomCredentialExchangers = Partial<
  Record<AuthCredentialTypes, BaseCredentialExchanger>
>;

/**
 * Automatically selects the appropriate credential exchanger based on the auth scheme.
 * Ported from Python implementation.
 *
 * @example
 * // Common case: a built-in exchanger handles the credential.
 * const exchanger = new AutoAuthCredentialExchanger();
 * const result = await exchanger.exchange({
 *   authScheme: serviceAccountScheme,
 *   authCredential: serviceAccountCredential,
 * });
 * // result.credential carries an OAuth token as a bearer token.
 *
 * @example
 * // Use CustomAuthExchanger for OAuth2 instead of the built-in exchanger.
 * const exchanger = new AutoAuthCredentialExchanger({
 *   [AuthCredentialTypes.OAUTH2]: new CustomAuthExchanger(),
 * });
 */
@experimental
export class AutoAuthCredentialExchanger implements BaseCredentialExchanger {
  private exchangers: Map<AuthCredentialTypes, BaseCredentialExchanger> =
    new Map();

  /**
   * @param customExchangers - Optional exchangers that add to or override the
   *   built-in ones. The key is the auth credential type; the value is the
   *   exchanger instance to use for that type.
   */
  constructor(customExchangers?: CustomCredentialExchangers) {
    this.exchangers.set(
      AuthCredentialTypes.OAUTH2,
      new OAuth2CredentialExchanger(),
    );
    this.exchangers.set(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      new OAuth2CredentialExchanger(),
    );
    this.exchangers.set(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      new ServiceAccountCredentialExchanger(),
    );

    for (const authType of Object.values(AuthCredentialTypes)) {
      const customExchanger = customExchangers?.[authType];
      if (customExchanger) {
        this.exchangers.set(authType, customExchanger);
      }
    }
  }

  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult>;
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential?: AuthCredential;
  }): Promise<ExchangeResult | null>;
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential?: AuthCredential;
  }): Promise<ExchangeResult | null> {
    const {authCredential, authScheme} = params;

    if (!authCredential) {
      return null;
    }

    const exchanger = this.exchangers.get(authCredential.authType);

    if (!exchanger) {
      // If no exchanger found, return the original credential as not exchanged
      return {
        credential: authCredential,
        wasExchanged: false,
      };
    }

    return exchanger.exchange({authScheme, authCredential});
  }
}
