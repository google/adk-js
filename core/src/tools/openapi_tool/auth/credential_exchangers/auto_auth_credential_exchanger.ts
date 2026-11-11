/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../../auth/auth_credential.js';
import {AuthScheme, OAuthGrantType} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {
  determineGrantType,
  OAuth2CredentialExchanger,
} from '../../../../auth/oauth2/oauth2_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';
import {generateAuthToken} from './oauth2_exchanger.js';
import {ServiceAccountCredentialExchanger} from './service_account_exchanger.js';

/**
 * A map from auth credential type to the exchanger that handles it, merged
 * over the built-in defaults.
 */
export type CustomCredentialExchangers = Partial<
  Record<AuthCredentialTypes, BaseCredentialExchanger>
>;

/**
 * Reports whether an authorization-code credential has neither a token nor an
 * authorization response to exchange yet, because the user has not signed in.
 */
function isPendingAuthorizationCode(
  authScheme: AuthScheme | undefined,
  authCredential: AuthCredential,
): boolean {
  return (
    !!authScheme &&
    determineGrantType(authScheme) === OAuthGrantType.AUTHORIZATION_CODE &&
    !authCredential.oauth2?.accessToken &&
    !authCredential.oauth2?.authCode &&
    !authCredential.oauth2?.authResponseUri
  );
}

/**
 * Builds the default exchanger for `OAUTH2` and `OPEN_ID_CONNECT`, which runs
 * {@link OAuth2CredentialExchanger} to fetch a token when one can be obtained
 * and then turns any access token into an HTTP bearer credential with
 * {@link generateAuthToken}.
 */
function createDefaultOAuth2Exchanger(): BaseCredentialExchanger {
  const tokenFetcher = new OAuth2CredentialExchanger();
  return {
    async exchange(params: {
      authScheme?: AuthScheme;
      authCredential: AuthCredential;
    }): Promise<ExchangeResult> {
      const {authScheme, authCredential} = params;
      if (authScheme && authCredential.http) {
        return {
          credential: authCredential,
          wasExchanged: false,
        };
      }
      if (isPendingAuthorizationCode(authScheme, authCredential)) {
        return {
          credential: authCredential,
          wasExchanged: false,
        };
      }
      const {credential, wasExchanged} = await tokenFetcher.exchange(params);
      const bearer = generateAuthToken(credential);
      return {
        credential: bearer,
        wasExchanged: wasExchanged || bearer !== credential,
      };
    },
  };
}

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
  /**
   * The exchanger used for each auth credential type.
   *
   * By default `OAUTH2` and `OPEN_ID_CONNECT` run
   * {@link OAuth2CredentialExchanger} and convert any access token with
   * {@link generateAuthToken}, and `SERVICE_ACCOUNT` maps to a
   * {@link ServiceAccountCredentialExchanger}, with any custom exchangers from
   * the constructor merged over them. The map is live: an entry added or
   * replaced after construction is used by the next {@link exchange} call.
   */
  readonly exchangers: Map<AuthCredentialTypes, BaseCredentialExchanger> =
    new Map();

  /**
   * @param customExchangers - Optional exchangers that add to or override the
   *   built-in ones. The key is the auth credential type; the value is the
   *   exchanger instance to use for that type.
   */
  constructor(customExchangers?: CustomCredentialExchangers) {
    this.exchangers.set(
      AuthCredentialTypes.OAUTH2,
      createDefaultOAuth2Exchanger(),
    );
    this.exchangers.set(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      createDefaultOAuth2Exchanger(),
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

  /**
   * Exchanges the credential with the exchanger registered for its type.
   *
   * @returns The credential unchanged, with `wasExchanged: false`, when no
   *     exchanger is registered for its type. Otherwise the delegate's result,
   *     or `null` when there is no credential at all.
   */
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
