/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {Context} from '../agents/context.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthScheme, AuthSchemeType, OAuthGrantType} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from './exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {BaseCredentialRefresher} from './refresher/base_credential_refresher.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';

/**
 * Reports whether `credential` is a simple credential that requires no
 * exchange or refresh step.
 */
function isSimpleCredential(credential: AuthCredential): boolean {
  return (
    credential.authType === AuthCredentialTypes.API_KEY ||
    credential.authType === AuthCredentialTypes.HTTP
  );
}

/**
 * Reports whether `credential` holds an authorization code or response URI
 * that has not been redeemed for an access token.
 */
function hasUnredeemedAuthCode(credential: AuthCredential): boolean {
  if (
    credential.authType !== AuthCredentialTypes.OAUTH2 &&
    credential.authType !== AuthCredentialTypes.OPEN_ID_CONNECT
  ) {
    return false;
  }
  const oauth2 = credential.oauth2;
  if (!oauth2 || oauth2.accessToken) {
    return false;
  }
  return Boolean(oauth2.authCode || oauth2.authResponseUri);
}

/**
 * Reports whether `authScheme` uses the OAuth2 client-credentials flow.
 */
function isClientCredentialsFlow(authScheme: AuthScheme): boolean {
  if (authScheme.type === AuthSchemeType.OAUTH2 && authScheme.flows) {
    return authScheme.flows.clientCredentials !== undefined;
  }

  if (
    authScheme.type === AuthSchemeType.OPEN_ID_CONNECT &&
    'grantTypesSupported' in authScheme &&
    Array.isArray(authScheme.grantTypesSupported)
  ) {
    return authScheme.grantTypesSupported.includes(
      OAuthGrantType.CLIENT_CREDENTIALS,
    );
  }

  return false;
}

/**
 * Validates that `authConfig` carries the required raw credential fields for
 * OAuth2 and OpenID Connect schemes.
 */
function validateAuthConfig(authConfig: AuthConfig): void {
  const rawCredential = authConfig.rawAuthCredential;
  if (!rawCredential) {
    if (
      authConfig.authScheme.type === AuthSchemeType.OAUTH2 ||
      authConfig.authScheme.type === AuthSchemeType.OPEN_ID_CONNECT
    ) {
      throw new Error(
        `rawAuthCredential is required for authScheme type ${authConfig.authScheme.type}`,
      );
    }
    return;
  }

  if (
    (rawCredential.authType === AuthCredentialTypes.OAUTH2 ||
      rawCredential.authType === AuthCredentialTypes.OPEN_ID_CONNECT) &&
    !rawCredential.oauth2
  ) {
    throw new Error(
      `authConfig.rawAuthCredential.oauth2 is required for credential type ${rawCredential.authType}`,
    );
  }
}

/**
 * Tail of the in-flight `getAuthCredential` chain for each
 * `(appName, userId, credentialKey)`. An entry is removed once the last call
 * queued for its key settles.
 */
const credentialLocks = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every earlier call queued under `key` has settled, so
 * parallel tool calls for one user's credential do not race on a cache miss
 * and exchange or refresh the same token twice.
 */
async function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = credentialLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  credentialLocks.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (credentialLocks.get(key) === tail) {
      credentialLocks.delete(key);
    }
  }
}

/**
 * Orchestrates loading, exchanging, refreshing, and saving tool authentication
 * credentials.
 */
export class CredentialManager {
  private readonly authConfig: AuthConfig;
  private readonly exchangerRegistry = new CredentialExchangerRegistry();
  private readonly refresherRegistry = new CredentialRefresherRegistry();

  /**
   * @param authConfig The {@link AuthConfig} containing the authentication
   *     scheme and credentials.
   */
  constructor(authConfig: AuthConfig) {
    this.authConfig = authConfig;

    const oauth2Exchanger = new OAuth2CredentialExchanger();
    this.exchangerRegistry.register(
      AuthCredentialTypes.OAUTH2,
      oauth2Exchanger,
    );
    this.exchangerRegistry.register(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2Exchanger,
    );

    const oauth2Refresher = new OAuth2CredentialRefresher();
    this.refresherRegistry.register(
      AuthCredentialTypes.OAUTH2,
      oauth2Refresher,
    );
    this.refresherRegistry.register(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2Refresher,
    );
  }

  /**
   * Registers a {@link BaseCredentialExchanger} for a credential type.
   */
  registerCredentialExchanger(
    credentialType: AuthCredentialTypes,
    exchangerInstance: BaseCredentialExchanger,
  ): void {
    this.exchangerRegistry.register(credentialType, exchangerInstance);
  }

  /**
   * Registers a {@link BaseCredentialRefresher} for a credential type.
   */
  registerCredentialRefresher(
    credentialType: AuthCredentialTypes,
    refresherInstance: BaseCredentialRefresher,
  ): void {
    this.refresherRegistry.register(credentialType, refresherInstance);
  }

  /**
   * Requests an authentication credential from the user via `toolContext`.
   */
  async requestCredential(toolContext: Context): Promise<void> {
    toolContext.requestCredential(this.authConfig);
  }

  /**
   * Loads, exchanges, refreshes, and persists the authentication credential
   * for the configured {@link AuthConfig}.
   *
   * Calls for the same app, user, and `credentialKey` run one at a time, so a
   * later call can reuse the credential an earlier one saved to the
   * credential service. Calls for other keys or users do not wait.
   */
  async getAuthCredential(
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    const session = toolContext.invocationContext.session;
    const lockKey = JSON.stringify([
      session.appName,
      session.userId,
      this.authConfig.credentialKey,
    ]);
    return runSerialized(lockKey, () =>
      this.loadAndPrepareCredential(toolContext),
    );
  }

  private async loadAndPrepareCredential(
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    validateAuthConfig(this.authConfig);

    const rawAuthCredential = this.authConfig.rawAuthCredential;
    if (rawAuthCredential && isSimpleCredential(rawAuthCredential)) {
      return cloneDeep(rawAuthCredential);
    }

    const isServiceAccount =
      rawAuthCredential?.authType === AuthCredentialTypes.SERVICE_ACCOUNT;

    let credential: AuthCredential | undefined;
    if (!isServiceAccount) {
      credential = await this.loadExistingCredential(toolContext);
      if (credential && hasUnredeemedAuthCode(credential)) {
        credential = undefined;
      }
    }

    let wasFromAuthResponse = false;
    if (!credential) {
      credential = toolContext.getAuthResponse(this.authConfig);
      if (credential) {
        wasFromAuthResponse = true;
      }
    }

    if (!credential) {
      if (
        rawAuthCredential &&
        isClientCredentialsFlow(this.authConfig.authScheme)
      ) {
        credential = cloneDeep(rawAuthCredential);
      } else {
        return undefined;
      }
    }

    const exchangeResult = await this.exchangeCredential(credential);
    credential = exchangeResult.credential;
    const wasExchanged = exchangeResult.wasExchanged;

    let wasRefreshed = false;
    if (!wasExchanged) {
      const refreshResult = await this.refreshCredential(credential);
      credential = refreshResult.credential;
      wasRefreshed = refreshResult.wasRefreshed;
    }

    if (hasUnredeemedAuthCode(credential)) {
      logger.warn(
        `Discarding credential for auth scheme ${this.authConfig.authScheme.type}: authorization code was not exchanged for an access token.`,
      );
      return undefined;
    }

    if (
      (wasFromAuthResponse || wasExchanged || wasRefreshed) &&
      !isServiceAccount
    ) {
      await this.saveCredential(toolContext, credential);
    }

    return credential;
  }

  private async loadExistingCredential(
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    const credentialService = toolContext.invocationContext.credentialService;
    if (credentialService) {
      const credential = await credentialService.loadCredential(
        this.authConfig,
        toolContext,
      );
      if (credential) {
        return credential;
      }
    }

    // `authConfig.exchangedAuthCredential` is not read here: one `AuthConfig`
    // is shared by every user of a tool, so a cached value would leak one
    // user's token to another.
    return undefined;
  }

  private async exchangeCredential(
    credential: AuthCredential,
  ): Promise<ExchangeResult> {
    const exchanger = this.exchangerRegistry.getExchanger(credential.authType);
    if (!exchanger) {
      return {credential, wasExchanged: false};
    }

    try {
      return await exchanger.exchange({
        authCredential: credential,
        authScheme: this.authConfig.authScheme,
      });
    } catch (error: unknown) {
      // `OAuth2CredentialExchanger` throws `CredentialExchangeError` when it
      // cannot exchange the credential, so treat that as "not exchanged".
      // Any other error propagates to the caller.
      if (!(error instanceof CredentialExchangeError)) {
        throw error;
      }
      logger.error(`Failed to exchange credential: ${formatError(error)}`);
      return {credential, wasExchanged: false};
    }
  }

  private async refreshCredential(
    credential: AuthCredential,
  ): Promise<{credential: AuthCredential; wasRefreshed: boolean}> {
    const refresher = this.refresherRegistry.getRefresher(credential.authType);
    if (!refresher) {
      return {credential, wasRefreshed: false};
    }

    if (
      await refresher.isRefreshNeeded(credential, this.authConfig.authScheme)
    ) {
      const rawAuthCredential = this.authConfig.rawAuthCredential;
      if (
        rawAuthCredential &&
        isClientCredentialsFlow(this.authConfig.authScheme) &&
        credential.oauth2 &&
        !credential.oauth2.refreshToken
      ) {
        const exchangeResult = await this.exchangeCredential(
          cloneDeep(rawAuthCredential),
        );
        if (exchangeResult.wasExchanged) {
          return {
            credential: exchangeResult.credential,
            wasRefreshed: true,
          };
        }
        return {credential, wasRefreshed: false};
      }

      const refreshedCredential = await refresher.refresh(
        credential,
        this.authConfig.authScheme,
      );
      return {credential: refreshedCredential, wasRefreshed: true};
    }

    return {credential, wasRefreshed: false};
  }

  private async saveCredential(
    toolContext: Context,
    credential: AuthCredential,
  ): Promise<void> {
    const credentialService = toolContext.invocationContext.credentialService;
    if (credentialService) {
      await credentialService.saveCredential(
        {
          ...this.authConfig,
          exchangedAuthCredential: credential,
        },
        toolContext,
      );
    }
  }
}
