/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthConfig, AuthHandler, State} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {bindCredentialResponse} from '../../src/auth/credential_response_binding.js';

/**
 * The full authorization-code round trip, from the request the agent raises to
 * the token the tool ends up with.
 *
 * Redacting the request event removes the client secret from everything the
 * client can see, which is the point, but the token endpoint still has to be
 * given one. These tests drive the real path end to end so that a redaction
 * that also breaks the exchange fails here rather than in someone's browser.
 */

const TOKEN_URL = 'https://oauth.example.com/token';
const CLIENT_ID = 'the-client-id';
const CLIENT_SECRET = 'the-client-secret';

/** The config as the tool holds it, secret included. */
function toolAuthConfig(): AuthConfig {
  return {
    credentialKey: 'test_key',
    authScheme: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://oauth.example.com/auth',
          tokenUrl: TOKEN_URL,
          scopes: {profile: 'profile scope'},
        },
      },
    },
    rawAuthCredential: {
      authType: 'oauth2',
      oauth2: {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: 'https://app.example.com/callback',
      },
    },
  } as AuthConfig;
}

describe('oauth2 authorization-code round trip', () => {
  let tokenRequests: URLSearchParams[];

  beforeEach(() => {
    tokenRequests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: {body?: unknown}) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        tokenRequests.push(params);
        // An authorization server rejects a token request that does not
        // authenticate the client, so model that rather than assuming success.
        if (params.get('client_secret') !== CLIENT_SECRET) {
          return new Response(JSON.stringify({error: 'invalid_client'}), {
            status: 401,
            headers: {'content-type': 'application/json'},
          });
        }
        return new Response(
          JSON.stringify({access_token: 'the-access-token', expires_in: 3600}),
          {status: 200, headers: {'content-type': 'application/json'}},
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the client secret out of the request the client receives', () => {
    const request = new AuthHandler(toolAuthConfig()).generateAuthRequest();

    expect(
      request.exchangedAuthCredential?.oauth2?.clientSecret,
    ).toBeUndefined();
    expect(request.rawAuthCredential?.oauth2?.clientSecret).toBeUndefined();
    // The client still gets what it needs to run the flow.
    expect(request.exchangedAuthCredential?.oauth2?.authUri).toContain(
      `client_id=${CLIENT_ID}`,
    );
  });

  it('exchanges the code for a token using the configured client secret', async () => {
    // Step 1: the agent raises the request. This is what reaches the client.
    const request = new AuthHandler(toolAuthConfig()).generateAuthRequest();
    const issuedState = request.exchangedAuthCredential?.oauth2?.state;

    // Step 2: the client answers with the redirect it landed on. The
    // preprocessor reconciles that against the request as read back off the
    // event, which is the redacted copy.
    const response = bindCredentialResponse(request, {
      exchangedAuthCredential: {
        oauth2: {
          authResponseUri: `https://app.example.com/callback?code=the-code&state=${issuedState}`,
        },
      },
    });
    expect(response).toBeDefined();

    const state = new State({});
    // The tool's own config is the authority for the client identity, so the
    // handler is given it the same way the tool holds it.
    await new AuthHandler({
      ...response!,
      rawAuthCredential: toolAuthConfig().rawAuthCredential,
    }).parseAndStoreAuthResponse(state);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get('client_id')).toBe(CLIENT_ID);
    expect(tokenRequests[0].get('client_secret')).toBe(CLIENT_SECRET);
    expect(tokenRequests[0].get('code')).toBe('the-code');

    const stored = state.get('temp:test_key') as
      | {oauth2?: {accessToken?: string; clientSecret?: string}}
      | undefined;
    expect(stored?.oauth2?.accessToken).toBe('the-access-token');
    // The stored copy lives in session state, so it keeps no secret either.
    expect(stored?.oauth2?.clientSecret).toBeUndefined();
  });

  it('defers the exchange when the config it was handed carries no secret', async () => {
    // The preprocessor path: the config comes back off the request event, so
    // it has been redacted and there is no secret to authenticate a token
    // request with. Attempting the exchange anyway is what broke the login.
    const request = new AuthHandler(toolAuthConfig()).generateAuthRequest();
    const response = bindCredentialResponse(request, {
      exchangedAuthCredential: {
        oauth2: {
          authResponseUri: `https://app.example.com/callback?code=the-code&state=${request.exchangedAuthCredential?.oauth2?.state}`,
        },
      },
    });

    const state = new State({});
    await new AuthHandler(response!).parseAndStoreAuthResponse(state);

    // No token request went out, and nothing threw.
    expect(tokenRequests).toHaveLength(0);

    // The authorization code is kept, so the tool can finish the exchange with
    // the credential it holds.
    const stored = state.get('temp:test_key') as
      | {oauth2?: {authResponseUri?: string; clientSecret?: string}}
      | undefined;
    expect(stored?.oauth2?.authResponseUri).toContain('code=the-code');
    expect(stored?.oauth2?.clientSecret).toBeUndefined();
  });
});
