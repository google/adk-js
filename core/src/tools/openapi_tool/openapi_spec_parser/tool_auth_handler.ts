/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../../agents/context.js';
import {AuthCredential} from '../../../auth/auth_credential.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {experimental} from '../../../utils/experimental.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authCredential?: AuthCredential;
}

class ToolContextCredentialStore {
  constructor(private readonly context: Context) {}

  getCredentialKey(authScheme?: OpenAPIV3.SecuritySchemeObject): string {
    const schemeName = authScheme?.type || 'default';
    return `${schemeName}_existing_exchanged_credential`;
  }

  getCredential(
    authScheme?: OpenAPIV3.SecuritySchemeObject,
  ): AuthCredential | undefined {
    const key = this.getCredentialKey(authScheme);
    const state = (this.context as unknown as {state: Record<string, unknown>})
      .state;
    if (state) {
      const serialized = state[key];
      if (serialized) {
        return serialized as AuthCredential;
      }
    }
    return undefined;
  }

  storeCredential(key: string, credential: AuthCredential) {
    const state = (this.context as unknown as {state: Record<string, unknown>})
      .state;
    if (state) {
      state[key] = credential;
    }
  }
}

@experimental
export class ToolAuthHandler {
  constructor(
    private readonly context: Context,
    private readonly authScheme?: OpenAPIV3.SecuritySchemeObject,
    private readonly authCredential?: AuthCredential,
    private readonly credentialKey?: string,
  ) {}

  @experimental
  public static fromToolContext(
    context: Context,
    authScheme?: OpenAPIV3.SecuritySchemeObject,
    authCredential?: AuthCredential,
    options: {credentialKey?: string} = {},
  ): ToolAuthHandler {
    return new ToolAuthHandler(
      context,
      authScheme,
      authCredential,
      options.credentialKey,
    );
  }

  @experimental
  public async prepareAuthCredentials(): Promise<AuthPreparationResult> {
    if (!this.authScheme) {
      return {state: 'done'};
    }

    const store = new ToolContextCredentialStore(this.context);
    const existingCredential = store.getCredential(this.authScheme);

    if (existingCredential) {
      return {state: 'done', authCredential: existingCredential};
    }

    const authConfig: AuthConfig = {
      authScheme: this.authScheme,
      rawAuthCredential: this.authCredential,
      credentialKey: this.credentialKey || 'default_openapi_key',
    };

    const credential = this.context.getAuthResponse(authConfig);
    if (credential) {
      const exchanger = new AutoAuthCredentialExchanger();
      const result = await exchanger.exchange({
        authScheme: this.authScheme,
        authCredential: credential,
      });

      const key = store.getCredentialKey(this.authScheme);
      store.storeCredential(key, result.credential);

      return {state: 'done', authCredential: result.credential};
    }

    // If credential is not available, request it
    this.context.requestCredential(authConfig);

    return {state: 'pending'};
  }
}
