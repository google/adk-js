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

// The auth request is sent to the client and stored in the session, so the
// agent's own secrets must not travel in it. They are re-supplied from the
// tool config when the credential is exchanged.
export function credentialWithoutSecrets(
  credential: AuthCredential | undefined,
): AuthCredential | undefined {
  if (!credential) {
    return credential;
  }
  const redacted = structuredClone(credential);
  if (redacted.oauth2) {
    redacted.oauth2.clientSecret = undefined;
  }
  if (redacted.apiKey !== undefined) {
    redacted.apiKey = undefined;
  }
  if (redacted.http?.credentials) {
    redacted.http.credentials.password = undefined;
  }
  if (redacted.serviceAccount?.serviceAccountCredential) {
    redacted.serviceAccount.serviceAccountCredential.privateKey = '';
  }
  return redacted;
}

/**
 * Restores the configured OAuth2 client identity onto a credential.
 *
 * The credential comes back from the client, which must not get to choose
 * which OAuth2 client the token is exchanged for, or where the secret that
 * exchange posts is sent. `configured` is the credential the agent holds, and
 * it wins on both fields. Only fills them in when the caller actually has a
 * configured client, so the redacted config read back off the request event
 * leaves the credential as it found it.
 */
export function withConfiguredClient(
  credential: AuthCredential | undefined,
  configured: AuthCredential | undefined,
): AuthCredential | undefined {
  if (!credential?.oauth2 || !configured?.oauth2) {
    return credential;
  }
  const restored = structuredClone(credential);
  restored.oauth2 = {
    ...restored.oauth2,
    clientId: configured.oauth2.clientId ?? restored.oauth2!.clientId,
    clientSecret:
      configured.oauth2.clientSecret ?? restored.oauth2!.clientSecret,
  };
  return restored;
}

/** Whether credential still needs, and is able to do, a token exchange. */
function isExchangeable(credential: AuthCredential): boolean {
  const oauth2 = credential.oauth2;
  return Boolean(
    oauth2 && !oauth2.accessToken && oauth2.clientId && oauth2.clientSecret,
  );
}

function authConfigWithoutSecrets(config: AuthConfig): AuthConfig {
  return {
    ...config,
    rawAuthCredential: credentialWithoutSecrets(config.rawAuthCredential),
    exchangedAuthCredential: credentialWithoutSecrets(
      config.exchangedAuthCredential,
    ),
  };
}

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

  /**
   * Stores the exchanged credential in the session state.
   *
   * @param state The session state to store the credential in.
   * @throws Error: If the auth config has no credentialKey.
   */
  async parseAndStoreAuthResponse(state: State): Promise<void> {
    if (!this.authConfig.credentialKey) {
      throw new Error('credentialKey is empty.');
    }

    const credentialKey = 'temp:' + this.authConfig.credentialKey;

    const authSchemeType = this.authConfig.authScheme.type;
    if (!['oauth2', 'openIdConnect'].includes(authSchemeType)) {
      state.set(credentialKey, this.authConfig.exchangedAuthCredential);

      return;
    }

    const credential = withConfiguredClient(
      this.authConfig.exchangedAuthCredential,
      this.authConfig.rawAuthCredential,
    );
    if (!credential) {
      return;
    }

    // Without a client secret there is nothing to authenticate the token
    // request with, so the exchange would fail rather than merely be
    // unauthenticated. That is the normal case here: the request event is
    // redacted, so the config read back off it carries no secret. Store the
    // authorization code and let the tool, which still holds the configured
    // credential, complete the exchange.
    if (!isExchangeable(credential)) {
      state.set(credentialKey, credential);

      return;
    }

    const exchanger = new OAuth2CredentialExchanger();
    const exchangedCredential = await exchanger.exchange({
      authCredential: credential,
      authScheme: this.authConfig.authScheme,
    });
    // The result goes into session state, which the client can read, so it
    // keeps no secret either.
    state.set(
      credentialKey,
      credentialWithoutSecrets(exchangedCredential.credential),
    );
  }

  generateAuthRequest(): AuthConfig {
    return authConfigWithoutSecrets(this.buildAuthRequest());
  }

  private buildAuthRequest(): AuthConfig {
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
