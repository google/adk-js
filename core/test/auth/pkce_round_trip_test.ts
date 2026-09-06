/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthConfig, AuthCredentialTypes, AuthHandler} from '@google/adk';
import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {createOAuth2TokenRequestBody} from '../../src/auth/oauth2/oauth2_utils.js';

/**
 * Drives the whole PKCE exchange with no mocks: the handler builds the
 * authorization URI, and the verifier it returns travels into the token
 * request body the exchanger sends. A provider accepts the exchange only when
 * the challenge on the URI is the SHA-256 of that body's `code_verifier`, so
 * this test performs the check the provider would.
 */
describe('PKCE round trip', () => {
  const authConfig: AuthConfig = {
    credentialKey: 'pkce-round-trip',
    authScheme: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/oauth2/authorize',
          tokenUrl: 'https://example.com/oauth2/token',
          scopes: {read: 'read access'},
        },
      },
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://example.com/callback',
        codeChallengeMethod: 'S256',
      },
    },
  };

  it('sends a code_verifier that the URI challenge verifies', () => {
    const requested = new AuthHandler(authConfig).generateAuthRequest();
    const oauth2 = requested.exchangedAuthCredential?.oauth2;
    if (!oauth2?.authUri || !oauth2.codeVerifier) {
      expect.fail('expected an auth URI and a code verifier');
    }

    const body = createOAuth2TokenRequestBody({
      grantType: 'authorization_code',
      clientId: 'id',
      clientSecret: 'secret',
      code: 'authorization-code-from-the-provider',
      redirectUri: 'https://example.com/callback',
      codeVerifier: oauth2.codeVerifier,
    });

    const params = new URL(oauth2.authUri).searchParams;
    const sentVerifier = body.get('code_verifier');
    expect(sentVerifier).toBe(oauth2.codeVerifier);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBe(
      createHash('sha256')
        .update(sentVerifier ?? '')
        .digest('base64url'),
    );
  });
});
