/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';
import {Context} from '../../../agents/context.js';
import {
  AuthCredential,
  isAuthCredential,
} from '../../../auth/auth_credential.js';
import {AuthScheme} from '../../../auth/auth_schemes.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from '../../../auth/exchanger/base_credential_exchanger.js';
import {experimental} from '../../../utils/experimental.js';
import {stableHash} from '../../../utils/hash_utils.js';
import {logger} from '../../../utils/logger.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';
import {AuthCredentialMissingError} from '../auth/credential_exchangers/base_auth_credential_exchanger.js';

/** Credential key used when the tool declares none of its own. */
const DEFAULT_CREDENTIAL_KEY = 'default_openapi_key';

/** The outcome of preparing a tool's credential. */
export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authScheme?: AuthScheme;
  authCredential?: AuthCredential;
}

/** Collaborators a caller may substitute when building a {@link ToolAuthHandler}. */
export interface ToolAuthHandlerOptions {
  /** Key under which a credential service loads and saves this credential. */
  credentialKey?: string;
  /** Exchanger to use instead of the default `AutoAuthCredentialExchanger`. */
  credentialExchanger?: BaseCredentialExchanger;
  /** Store to use instead of one built over the tool's own context. */
  credentialStore?: ToolContextCredentialStore;
}

/**
 * Stores and retrieves exchanged credentials in the session state carried by a
 * {@link Context}.
 */
export class ToolContextCredentialStore {
  constructor(private readonly context: Context) {}

  /**
   * Returns the state key that holds the credential exchanged for this scheme
   * and credential pair.
   *
   * Both operands are hashed into the key, so two tools configured with
   * different schemes, or with different credentials under one scheme, never
   * share a slot.
   *
   * The key deliberately carries no `temp:` prefix. Session state is a copy and
   * only the delta is persisted, and `temp:` is cleared at the end of a run,
   * while an exchanged token has to stay readable across runs.
   */
  getCredentialKey(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): string {
    const schemeName = authScheme
      ? `${authScheme.type}_${stableHash(authScheme)}`
      : '';
    const credentialName = authCredential
      ? `${authCredential.authType}_${stableHash(authCredential)}`
      : '';
    return `${schemeName}_${credentialName}_existing_exchanged_credential`;
  }

  /**
   * Returns the credential stored for this scheme and credential pair, or
   * `undefined` when there is none.
   *
   * @throws Error if the state entry under the key is not an
   *     {@link AuthCredential}, which means something else wrote to the key.
   */
  getCredential(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): AuthCredential | undefined {
    const key = this.getCredentialKey(authScheme, authCredential);
    // Read through the State API so we see values persisted from previous
    // tool calls. `context.state` is a `State` instance, not a plain object;
    // bracket access would bypass its value/delta store and always miss.
    const stored = this.context.state.get<unknown>(key);
    if (stored === undefined || stored === null) {
      return undefined;
    }
    if (!isAuthCredential(stored)) {
      throw new Error(
        `State entry '${key}' is not an AuthCredential. Another writer has ` +
          'taken this key.',
      );
    }
    return stored;
  }

  storeCredential(key: string, credential: AuthCredential) {
    // Use State.set so the credential is recorded in the state delta and
    // persisted to the session. A plain assignment (`state[key] = ...`) sets
    // an own property on the State instance that is never committed, so the
    // exchanged credential would be re-created on every tool invocation.
    // The JSON round trip drops `undefined` members and detaches the stored
    // value from the caller's object.
    this.context.state.set(key, JSON.parse(JSON.stringify(credential)));
  }

  /**
   * Makes the credential under `key` unreadable again.
   *
   * adk-python deletes the state entry. `State` has no delete, so this writes
   * `undefined`, which `State.get` returns for a missing key as well, and
   * {@link getCredential} therefore misses exactly as a delete would make it.
   */
  removeCredential(key: string): void {
    this.context.state.set(key, undefined);
  }
}

@experimental
export class ToolAuthHandler {
  private readonly authScheme?: AuthScheme;
  private readonly authCredential?: AuthCredential;
  private readonly credentialKey?: string;
  private readonly credentialExchanger?: BaseCredentialExchanger;
  private readonly credentialStore: ToolContextCredentialStore;

  constructor(
    private readonly context: Context,
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
    options: ToolAuthHandlerOptions = {},
  ) {
    // Copy both, so a caller that keeps mutating the objects it passed in
    // cannot change this handler's cache key or its result mid-flight.
    this.authScheme = authScheme ? cloneDeep(authScheme) : undefined;
    this.authCredential = authCredential
      ? cloneDeep(authCredential)
      : undefined;
    this.credentialKey = options.credentialKey;
    this.credentialExchanger = options.credentialExchanger;
    this.credentialStore =
      options.credentialStore ?? new ToolContextCredentialStore(context);
  }

  @experimental
  public static fromToolContext(
    context: Context,
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
    options: ToolAuthHandlerOptions = {},
  ): ToolAuthHandler {
    return new ToolAuthHandler(context, authScheme, authCredential, options);
  }

  @experimental
  public async prepareAuthCredentials(): Promise<AuthPreparationResult> {
    if (!this.authScheme) {
      return {state: 'done'};
    }

    const existingCredential = this.credentialStore.getCredential(
      this.authScheme,
      this.authCredential,
    );

    if (existingCredential) {
      return {
        state: 'done',
        authScheme: this.authScheme,
        authCredential: existingCredential,
      };
    }

    const authConfig: AuthConfig = {
      authScheme: this.authScheme,
      rawAuthCredential: this.authCredential,
      credentialKey: this.credentialKey || DEFAULT_CREDENTIAL_KEY,
    };

    // A credential returned by an auth response was supplied interactively by
    // the client. Otherwise fall back to the credential the tool was
    // configured with: schemes such as `apiKey`, `http` and `serviceAccount`
    // need no user interaction, so requesting one would strand the tool in
    // `pending` forever.
    const authResponseCredential = this.context.getAuthResponse(authConfig);
    const credential = authResponseCredential ?? this.authCredential;

    const exchanged = credential
      ? await this.tryExchange(credential)
      : undefined;

    if (!exchanged) {
      this.requestCredential(authConfig);
      return {
        state: 'pending',
        authScheme: this.authScheme,
        authCredential: this.authCredential,
      };
    }

    // Only cache what cannot cheaply be obtained again: an auth response is
    // readable once, and an exchange costs a round trip. A statically
    // configured credential that needed no exchange is already available on
    // every invocation, so persisting it to session state would only copy a
    // secret into the session store for nothing.
    if (authResponseCredential || exchanged.wasExchanged) {
      const key = this.credentialStore.getCredentialKey(
        this.authScheme,
        this.authCredential,
      );
      this.credentialStore.storeCredential(key, exchanged.credential);
    }

    return {
      state: 'done',
      authScheme: this.authScheme,
      authCredential: exchanged.credential,
    };
  }

  /**
   * Exchanges `credential`, or returns `undefined` when the exchange failed.
   *
   * An exchange failure is transient far more often than it is fatal, so it
   * becomes a `pending` result the client can resume from rather than an
   * exception that fails the whole tool call.
   */
  private async tryExchange(
    credential: AuthCredential,
  ): Promise<ExchangeResult | undefined> {
    // Default the exchanger here rather than in the constructor, so that a
    // caller which replaces the module's export sees the replacement.
    const exchanger =
      this.credentialExchanger ?? new AutoAuthCredentialExchanger();
    try {
      return await exchanger.exchange({
        authScheme: this.authScheme,
        authCredential: credential,
      });
    } catch (e: unknown) {
      logger.error(
        `Failed to exchange credential: ${e instanceof Error ? e.message : e}`,
      );
      return undefined;
    }
  }

  /**
   * Asks the client for a credential, after checking that an interactive
   * scheme has the OAuth2 client configuration it cannot proceed without.
   *
   * @throws Error if an `oauth2` or `openIdConnect` scheme has no OAuth2
   *     credential.
   * @throws AuthCredentialMissingError if that credential omits `clientId` or
   *     `clientSecret`.
   */
  private requestCredential(authConfig: AuthConfig): void {
    const schemeType = this.authScheme?.type;
    if (schemeType === 'oauth2' || schemeType === 'openIdConnect') {
      const oauth2 = this.authCredential?.oauth2;
      if (!oauth2) {
        throw new Error(
          `authCredential is empty for scheme ${schemeType}. ` +
            'Please create AuthCredential using OAuth2Auth.',
        );
      }
      if (!oauth2.clientId) {
        throw new AuthCredentialMissingError(
          'OAuth2 credentials clientId is missing.',
        );
      }
      if (!oauth2.clientSecret) {
        throw new AuthCredentialMissingError(
          'OAuth2 credentials clientSecret is missing.',
        );
      }
    }

    this.context.requestCredential(authConfig);
  }
}
