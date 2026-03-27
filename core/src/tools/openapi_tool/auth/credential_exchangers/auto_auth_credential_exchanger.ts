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
import {ServiceAccountCredentialExchanger} from '../../../../auth/exchanger/service_account_credential_exchanger.js';
import {OAuth2CredentialExchanger} from '../../../../auth/oauth2/oauth2_credential_exchanger.js';

/**
 * Automatically selects the appropriate credential exchanger based on the credential type.
 */
export class AutoAuthCredentialExchanger implements BaseCredentialExchanger {
  private exchangers: Map<
    AuthCredentialTypes,
    new () => BaseCredentialExchanger
  >;

  constructor(
    customExchangers?: Map<
      AuthCredentialTypes,
      new () => BaseCredentialExchanger
    >,
  ) {
    this.exchangers = new Map();
    this.exchangers.set(AuthCredentialTypes.OAUTH2, OAuth2CredentialExchanger);
    this.exchangers.set(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      OAuth2CredentialExchanger,
    );
    this.exchangers.set(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      ServiceAccountCredentialExchanger,
    );

    if (customExchangers) {
      for (const [type, exchangerClass] of customExchangers.entries()) {
        this.exchangers.set(type, exchangerClass);
      }
    }
  }

  /**
   * Exchanges the provided authentication credential using the appropriate exchanger.
   *
   * @param authCredential - The authentication credential to exchange.
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

    const exchangerClass = this.exchangers.get(authCredential.authType);

    if (!exchangerClass) {
      return {
        credential: authCredential,
        wasExchanged: false,
      };
    }

    const exchanger = new exchangerClass();
    return exchanger.exchange({authCredential, authScheme});
  }
}
