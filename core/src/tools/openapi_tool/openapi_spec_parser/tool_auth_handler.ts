/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../../agents/context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../auth/auth_credential.js';
import {AuthScheme} from '../../../auth/auth_schemes.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {BaseCredentialExchanger} from '../../../auth/exchanger/base_credential_exchanger.js';
import {OAuth2CredentialRefresher} from '../../../auth/oauth2/oauth2_credential_refresher.js';
import {logger} from '../../../utils/logger.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

export type AuthPreparationState = 'pending' | 'done';

/**
 * Result of the credential preparation process.
 */
export interface AuthPreparationResult {
  state: AuthPreparationState;
  authScheme?: AuthScheme;
  authCredential?: AuthCredential;
}

/**
 * Handles storage and retrieval of credentials within a Context.
 */
export class ToolContextCredentialStore {
  constructor(private context: Context) {}

  /**
   * Generates a stable digest for a text.
   * In Node/Browser this would be async if using crypto.subtle.
   * Here we use a simple string representation or a standard JSON.stringify
   * for sync use in key generation, as it is just for transient session state.
   */
  private stableDigest(obj: unknown): string {
    if (!obj) return '';
    // A simple stable string representation (sorted keys)
    return JSON.stringify(obj, Object.keys(obj as object).sort());
  }

  private getLegacyCredentialKey(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): string {
    let cred = authCredential;
    if (cred && cred.oauth2) {
      cred = {...cred, oauth2: {...cred.oauth2}};
      cred.oauth2!.authUri = undefined;
      cred.oauth2!.state = undefined;
      cred.oauth2!.authResponseUri = undefined;
      cred.oauth2!.authCode = undefined;
      cred.oauth2!.accessToken = undefined;
      cred.oauth2!.refreshToken = undefined;
      cred.oauth2!.expiresAt = undefined;
      cred.oauth2!.expiresIn = undefined;
    }

    const schemeName = authScheme
      ? `${authScheme.type}_${this.stableDigest(authScheme)}`
      : '';
    const credentialName = cred
      ? `${cred.authType}_${this.stableDigest(cred)}`
      : '';

    return `${schemeName}_${credentialName}_existing_exchanged_credential`;
  }

  getCredentialKey(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): string {
    let cred = authCredential;
    if (cred && cred.oauth2) {
      cred = {...cred, oauth2: {...cred.oauth2}};
      cred.oauth2!.authUri = undefined;
      cred.oauth2!.state = undefined;
      cred.oauth2!.authResponseUri = undefined;
      cred.oauth2!.authCode = undefined;
      cred.oauth2!.accessToken = undefined;
      cred.oauth2!.refreshToken = undefined;
      cred.oauth2!.expiresAt = undefined;
      cred.oauth2!.expiresIn = undefined;
    }

    const schemeName = authScheme
      ? `${authScheme.type}_${this.stableDigest(authScheme)}`
      : '';
    const credentialName = cred
      ? `${cred.authType}_${this.stableDigest(cred)}`
      : '';

    return `${schemeName}_${credentialName}_existing_exchanged_credential`;
  }

  getCredential(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): AuthCredential | undefined {
    if (!this.context) return undefined;

    const tokenKey = this.getCredentialKey(authScheme, authCredential);
    const serializedCredential = this.context.state.get(tokenKey);

    if (serializedCredential) {
      return serializedCredential as AuthCredential;
    }

    const legacyKey = this.getLegacyCredentialKey(authScheme, authCredential);
    if (legacyKey === tokenKey) {
      return undefined;
    }

    const serializedLegacyCredential = this.context.state.get(legacyKey);
    if (!serializedLegacyCredential) {
      return undefined;
    }

    this.context.state.set(tokenKey, serializedLegacyCredential);
    return serializedLegacyCredential as AuthCredential;
  }

  storeCredential(key: string, authCredential?: AuthCredential): void {
    if (this.context && authCredential) {
      this.context.state.set(key, authCredential);
    }
  }

  removeCredential(key: string): void {
    if (this.context) {
      this.context.state.set(key, undefined);
    }
  }
}

/**
 * Handles the preparation and exchange of authentication credentials for tools.
 */
export class ToolAuthHandler {
  private credentialExchanger: BaseCredentialExchanger;
  private credentialStore?: ToolContextCredentialStore;
  private shouldStoreCredential = true;
  private credentialKeyOverride?: string;

  constructor(
    private context: Context,
    private authScheme?: AuthScheme,
    private authCredential?: AuthCredential,
    options?: {
      credentialExchanger?: BaseCredentialExchanger;
      credentialStore?: ToolContextCredentialStore;
      credentialKey?: string;
    },
  ) {
    this.credentialExchanger =
      options?.credentialExchanger || new AutoAuthCredentialExchanger();
    this.credentialStore = options?.credentialStore;
    this.credentialKeyOverride = options?.credentialKey;

    if (this.authScheme) {
      this.authScheme = JSON.parse(JSON.stringify(this.authScheme)); // Deep copy if needed, or structuredClone
    }
    if (this.authCredential) {
      this.authCredential = JSON.parse(JSON.stringify(this.authCredential));
    }
  }

  private getCredentialKeyOverride(): string | undefined {
    if (this.credentialKeyOverride) {
      return this.credentialKeyOverride;
    }

    const objectsToCheck = [this.authCredential, this.authScheme];
    for (const obj of objectsToCheck) {
      if (obj) {
        // In TS, we don't have model_extra in standard interfaces unless defined.
        // If we want to check for 'credentialKey' or 'credential_key' property that might be ad-hoc:
        const anyObj = obj as any;
        if (anyObj.credentialKey) return anyObj.credentialKey;
        if (anyObj.credential_key) return anyObj.credential_key;
      }
    }
    return undefined;
  }

  private buildAuthConfig(): AuthConfig {
    return {
      authScheme: this.authScheme!, // Assume it's checked or handled if used
      rawAuthCredential: this.authCredential,
      credentialKey: this.getCredentialKeyOverride() || '',
    };
  }

  static fromToolContext(
    context: Context,
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
    options?: {
      credentialExchanger?: BaseCredentialExchanger;
      credentialKey?: string;
    },
  ): ToolAuthHandler {
    const credentialStore = new ToolContextCredentialStore(context);
    return new ToolAuthHandler(context, authScheme, authCredential, {
      ...options,
      credentialStore,
    });
  }

  private async getExistingCredential(): Promise<AuthCredential | undefined> {
    if (this.credentialStore) {
      let existingCredential = this.credentialStore.getCredential(
        this.authScheme,
        this.authCredential,
      );

      if (existingCredential) {
        if (existingCredential.oauth2) {
          const refresher = new OAuth2CredentialRefresher();
          if (await refresher.isRefreshNeeded(existingCredential)) {
            existingCredential = await refresher.refresh(
              existingCredential,
              this.authScheme,
            );
          }
        }
        return existingCredential;
      }
    }
    return undefined;
  }

  private async exchangeCredential(
    authCredential: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    try {
      const result = await this.credentialExchanger.exchange({
        authCredential,
        authScheme: this.authScheme,
      });
      return result.credential;
    } catch (e) {
      logger.error(`Failed to exchange credential: ${e}`);
      return undefined;
    }
  }

  private storeCredentialInStore(authCredential: AuthCredential): void {
    if (this.credentialStore) {
      const key = this.credentialStore.getCredentialKey(
        this.authScheme,
        this.authCredential,
      );
      this.credentialStore.storeCredential(key, authCredential);
    }
  }

  private requestCredential(): void {
    if (this.authScheme) {
      if (
        this.authScheme.type === 'openIdConnect' ||
        this.authScheme.type === 'oauth2'
      ) {
        if (!this.authCredential || !this.authCredential.oauth2) {
          throw new Error(
            `authCredential is empty for scheme ${this.authScheme.type}. Please create AuthCredential using OAuth2Auth.`,
          );
        }

        if (!this.authCredential.oauth2.clientId) {
          throw new Error('OAuth2 credentials client_id is missing.');
        }

        if (!this.authCredential.oauth2.clientSecret) {
          throw new Error('OAuth2 credentials client_secret is missing.');
        }
      }
    }

    this.context.requestCredential(this.buildAuthConfig());
  }

  private getAuthResponse(): AuthCredential | undefined {
    return this.context.getAuthResponse(this.buildAuthConfig());
  }

  private externalExchangeRequired(credential: AuthCredential): boolean {
    return (
      (credential.authType === AuthCredentialTypes.OAUTH2 ||
        credential.authType === AuthCredentialTypes.OPEN_ID_CONNECT) &&
      !credential.oauth2?.accessToken
    );
  }

  async prepareAuthCredentials(): Promise<AuthPreparationResult> {
    if (!this.authScheme) {
      return {state: 'done'};
    }

    const existingCredential = await this.getExistingCredential();
    let credential = existingCredential || this.authCredential;

    if (!credential || this.externalExchangeRequired(credential)) {
      const fetchedCredential = this.getAuthResponse();
      if (fetchedCredential) {
        credential = fetchedCredential;
        this.storeCredentialInStore(credential);
      } else {
        this.requestCredential();
        return {
          state: 'pending',
          authScheme: this.authScheme,
          authCredential: this.authCredential,
        };
      }
    }

    const exchangedCredential = await this.exchangeCredential(credential);

    return {
      state: 'done',
      authScheme: this.authScheme,
      authCredential: exchangedCredential || credential, // Fallback if exchange fails or returns same
    };
  }
}
