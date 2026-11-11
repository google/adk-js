/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {State} from '../sessions/state.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {AuthCredential} from './auth_credential.js';
import {AuthConfig} from './auth_tool.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';
import {
  createS256CodeChallenge,
  generateCodeVerifier,
} from './oauth2/oauth2_utils.js';

/** The only PKCE code challenge method this handler supports. */
const S256_CODE_CHALLENGE_METHOD = 'S256';

/**
 * A handler that handles the auth flow in Agent Development Kit to help
 * orchestrates the credential request and response flow (e.g. OAuth flow)
 * This class should only be used by Agent Development Kit.
 */
export class AuthHandler {
  /**
   * @param authConfig The auth config this handler reads. It stays readable
   *     and replaceable after construction; each method reads the current
   *     value.
   */
  constructor(public authConfig: AuthConfig) {}

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

    if (this.authConfig.exchangedAuthCredential) {
      const exchanger = new OAuth2CredentialExchanger();
      const exchangedCredential = await exchanger.exchange({
        authCredential: this.authConfig.exchangedAuthCredential,
        authScheme: this.authConfig.authScheme,
      });
      state.set(credentialKey, exchangedCredential.credential);
    }
  }

  /**
   * Builds the auth request to send to the client.
   *
   * The result is always a new object, and its `exchangedAuthCredential` is
   * never an object held by {@link authConfig}. A caller that fills in the
   * response, for example `exchangedAuthCredential.oauth2.authResponseUri`,
   * therefore leaves the handler's credentials unchanged.
   *
   * When the config is returned as is, because the scheme is not OAuth2 or
   * OpenID Connect or the exchanged credential already has an auth URI, the
   * result is a deep copy of the whole config. In the other branches only the
   * exchanged credential is guaranteed independent: `authScheme` and
   * `rawAuthCredential` are the handler's own objects.
   *
   * @return The auth config to request from the client.
   * @throws Error: If an OAuth2 or OpenID Connect scheme has no raw
   *     credential, no `oauth2` on it, or no client ID and secret.
   */
  generateAuthRequest(): AuthConfig {
    const authSchemeType = this.authConfig.authScheme.type;

    if (!['oauth2', 'openIdConnect'].includes(authSchemeType)) {
      return cloneDeep(this.authConfig);
    }

    if (this.authConfig.exchangedAuthCredential?.oauth2?.authUri) {
      return cloneDeep(this.authConfig);
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
        exchangedAuthCredential: cloneDeep(this.authConfig.rawAuthCredential),
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
   * When the credential requests PKCE, the URI also carries the S256 code
   * challenge derived from the credential's code verifier, and the returned
   * credential carries the verifier the later token exchange must send.
   *
   * The URI leaves out `redirect_uri` when the credential has no
   * `redirectUri`, so the provider uses the redirect registered for the
   * client, and leaves out `scope` when the scheme lists no scopes.
   *
   * @return An AuthCredential object containing the auth URI and state.
   * @throws Error: If the authorization endpoint is not configured in the
   *     auth scheme, or the credential requests a code challenge method other
   *     than 'S256'.
   */
  generateAuthUri(): AuthCredential | undefined {
    const authScheme = this.authConfig.authScheme;
    const authCredential = this.authConfig.rawAuthCredential;

    if (!authCredential || !authCredential.oauth2) {
      return authCredential;
    }

    const oauth2 = authCredential.oauth2;
    const codeChallengeMethod = oauth2.codeChallengeMethod;
    if (
      codeChallengeMethod &&
      codeChallengeMethod !== S256_CODE_CHALLENGE_METHOD
    ) {
      throw new Error(
        `Unsupported codeChallengeMethod: ${codeChallengeMethod}. Only '${S256_CODE_CHALLENGE_METHOD}' is supported.`,
      );
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
    url.searchParams.set('client_id', oauth2.clientId || '');
    if (oauth2.redirectUri) {
      url.searchParams.set('redirect_uri', oauth2.redirectUri);
    }
    url.searchParams.set('response_type', 'code');
    if (scopes.length > 0) {
      url.searchParams.set('scope', scopes.join(' '));
    }
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    if (oauth2.audience) {
      url.searchParams.set('audience', oauth2.audience);
    }
    if (oauth2.nonce) {
      url.searchParams.set('nonce', oauth2.nonce);
    }

    // A verifier without a requested method stays off the URI: the provider
    // has no challenge to bind it to, so advertising one would be a lie.
    let codeVerifier = oauth2.codeVerifier;
    if (codeChallengeMethod) {
      codeVerifier ??= generateCodeVerifier();
      url.searchParams.set(
        'code_challenge',
        createS256CodeChallenge(codeVerifier),
      );
      url.searchParams.set('code_challenge_method', codeChallengeMethod);
    }

    const exchangedAuthCredential: AuthCredential = {
      ...authCredential,
      oauth2: {
        ...oauth2,
        authUri: url.toString(),
        state,
        codeVerifier,
      },
    };

    return exchangedAuthCredential;
  }
}
