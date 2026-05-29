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
 * Automatically selects the appropriate credential exchanger based on the auth scheme.
 * Ported from Python implementation.
 */
@experimental
export class AutoAuthCredentialExchanger implements BaseCredentialExchanger {
  private exchangers: Map<AuthCredentialTypes, BaseCredentialExchanger> =
    new Map();

  constructor() {
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
  }

  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential, authScheme} = params;

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
