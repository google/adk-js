/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from '../sessions/state.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {AuthCredential} from './auth_credential.js';
import {AuthConfig} from './auth_tool.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';

/**
 * A handler that handles the auth flow in Agent Development Kit to help
 * orchestrates the credential request and response flow (e.g. OAuth flow)
 * This class should only be used by Agent Development Kit.
 */
export class AuthHandler {
  constructor(private readonly authConfig: AuthConfig) {}

  getAuthResponse(state: State): AuthCredential | undefined {
    const credentialKey = 'temp:' + this.authConfig.credentialKey;

    return state.get<AuthCredential>(credentialKey);
  }

  async parseAndStoreAuthResponse(state: State): Promise<void> {
    const credentialKey = 'temp:' + this.authConfig.credentialKey;

    const authSchemeType = this.authConfig.authScheme.type;
    if (!['oauth2', 'openIdConnect'].includes(authSchemeType)) {
      state.set(credentialKey, this.authConfig.exchangedAuthCredential);

      return;
    }

    if (this.authConfig.exchangedAuthCredential) {
      const exchanger = new OAuth2CredentialExchanger();
      const exchangedCredential = await exchanger.exchange({
        authCredential: this.authConfig.exchangedAuthCredential,
        authScheme: this.authConfig.authScheme,
      });
      state.set(credentialKey, exchangedCredential.credential);
    }
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
        `Auth Scheme ${authSchemeType} requires oauth2 in authCredential.`,
      );
    }

    if (this.authConfig.rawAuthCredential.oauth2.authUri) {
      return {
        credentialKey: this.authConfig.credentialKey,
        authScheme: this.authConfig.authScheme,
        rawAuthCredential: this.authConfig.rawAuthCredential,
        exchangedAuthCredential: this.authConfig.rawAuthCredential,
      };
    }

    if (
      !this.authConfig.rawAuthCredential.oauth2.clientId ||
      !this.authConfig.rawAuthCredential.oauth2.clientSecret
    ) {
      throw new Error(
        `Auth Scheme ${authSchemeType} requires both clientId and clientSecret in authCredential.oauth2.`,
      );
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
  generateAuthUri(): AuthCredential | undefined {
    const authScheme = this.authConfig.authScheme;
    const authCredential = this.authConfig.rawAuthCredential;

    if (!authCredential || !authCredential.oauth2) {
      return authCredential;
    }

    let authorizationEndpoint = '';
    let scopes: string[] = [];

    if ('authorizationEndpoint' in authScheme) {
      authorizationEndpoint = authScheme.authorizationEndpoint;
      scopes = authScheme.scopes || [];
    } else if (authScheme.type === 'oauth2' && authScheme.flows) {
      const flows = authScheme.flows;
      const flow =
        flows.implicit ||
        flows.authorizationCode ||
        flows.clientCredentials ||
        flows.password;

      if (flow) {
        if ('authorizationUrl' in flow && flow.authorizationUrl) {
          authorizationEndpoint = flow.authorizationUrl;
        } else if ('tokenUrl' in flow && flow.tokenUrl) {
          authorizationEndpoint = flow.tokenUrl;
        }

        if (flow.scopes) {
          scopes = Object.keys(flow.scopes);
        }
      }
    }

    if (!authorizationEndpoint) {
      throw new Error('Authorization endpoint not configured in auth scheme.');
    }

    const state = randomUUID();
    const url = new URL(authorizationEndpoint);
    url.searchParams.set('client_id', authCredential.oauth2.clientId || '');
    url.searchParams.set(
      'redirect_uri',
      authCredential.oauth2.redirectUri || '',
    );
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    const exchangedAuthCredential: AuthCredential = {
      ...authCredential,
      oauth2: {
        ...authCredential.oauth2,
        authUri: url.toString(),
        state,
      },
    };

    return exchangedAuthCredential;
  }
}
