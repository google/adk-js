/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from '../sessions/state.js';

import {AuthCredential} from './auth_credential.js';
import {AuthConfig} from './auth_tool.js';

// TODO(b/425992518): Implement the rest
/**
 * A handler that handles the auth flow in Agent Development Kit to help
 * orchestrates the credential request and response flow (e.g. OAuth flow)
 * This class should only be used by Agent Development Kit.
 */
export class AuthHandler {
  constructor(private readonly authConfig: AuthConfig) {}

  getAuthResponse(state: State): AuthCredential|undefined {
    const credentialKey = 'temp:' + this.authConfig.credentialKey;

    return state.get<AuthCredential>(credentialKey);
  }

  generateAuthRequest(): AuthConfig {
    const authSchemeType = this.authConfig.authScheme.type;

    if (!['oauth2', 'openIdConnect'].includes(authSchemeType)) {
      return this.authConfig;
    }

    if (this.authConfig.exchangedAuthCredential?.oauth2?.authUri) {
      return this.authConfig;
    }

    if (!this.authConfig.rawAuthCredential) {
      throw new Error(`Auth Scheme ${authSchemeType} requires authCredential.`);
    }

    if (!this.authConfig.rawAuthCredential.oauth2) {
      throw new Error(
          `Auth Scheme ${authSchemeType} requires oauth2 in authCredential.`);
    }

    if (this.authConfig.rawAuthCredential.oauth2.authUri) {
      return {
        credentialKey: this.authConfig.credentialKey,
        authScheme: this.authConfig.authScheme,
        rawAuthCredential: this.authConfig.rawAuthCredential,
        exchangedAuthCredential: this.authConfig.rawAuthCredential,
      };
    }

    if (!this.authConfig.rawAuthCredential.oauth2.clientId ||
        !this.authConfig.rawAuthCredential.oauth2.clientSecret) {
      throw new Error(`Auth Scheme ${
          authSchemeType} requires both clientId and clientSecret in authCredential.oauth2.`);
    }

    return {
      credentialKey: this.authConfig.credentialKey,
      authScheme: this.authConfig.authScheme,
      rawAuthCredential: this.authConfig.rawAuthCredential,
      exchangedAuthCredential: this.generateAuthUri(),
    };
  }

  /**
   * Generates an response containing the auth uri for user to sign in.
   *
   * @return An AuthCredential object containing the auth URI and state.
   * @throws Error: If the authorization endpoint is not configured in the
   *     auth scheme.
   */
  generateAuthUri(): AuthCredential|undefined {
    return this.authConfig.rawAuthCredential;
    // TODO - b/425992518: Implement the rest of the function
  }
}
