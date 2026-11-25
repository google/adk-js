/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Context,
  type GoogleCredentials,
  GoogleCredentialsManager,
  GoogleOAuthCredentialsImpl,
  isBaseGoogleCredentialsConfig,
  State,
} from '@google/adk';
import {
  isSpannerCredentialsConfig,
  SPANNER_DEFAULT_SCOPE,
  SPANNER_TOKEN_CACHE_KEY,
  SpannerCredentialsConfig,
  type SpannerCredentialsConfigOptions,
} from '@google/adk-integrations';
import {GoogleAuth, JWT, OAuth2Client} from 'google-auth-library';
import {describe, expect, it, vi} from 'vitest';

function createMockToolContext(initialState: Record<string, unknown> = {}): {
  context: Context;
  getAuthResponse: ReturnType<typeof vi.fn>;
  requestCredential: ReturnType<typeof vi.fn>;
  state: State;
} {
  const getAuthResponse = vi.fn(() => undefined);
  const requestCredential = vi.fn();
  const state = new State(initialState);
  const context = {
    getAuthResponse,
    requestCredential,
    state,
  } as unknown as Context;
  return {context, getAuthResponse, requestCredential, state};
}

describe('SpannerCredentialsConfig', () => {
  it('exposes the default token cache key and frozen Spanner scopes', () => {
    expect(SPANNER_TOKEN_CACHE_KEY).toBe('spanner_token_cache');
    expect(SPANNER_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/spanner.admin',
      'https://www.googleapis.com/auth/spanner.data',
    ]);
    expect(Object.isFrozen(SPANNER_DEFAULT_SCOPE)).toBe(true);
  });

  it('identifies instances via isSpannerCredentialsConfig and isBaseGoogleCredentialsConfig', () => {
    const options: SpannerCredentialsConfigOptions = {
      clientId: 'testClientId',
      clientSecret: 'testClientSecret',
    };
    const config = new SpannerCredentialsConfig(options);

    expect(isSpannerCredentialsConfig(config)).toBe(true);
    expect(isBaseGoogleCredentialsConfig(config)).toBe(true);
    expect(isSpannerCredentialsConfig({})).toBe(false);
    expect(isSpannerCredentialsConfig(null)).toBe(false);
    expect(isSpannerCredentialsConfig(undefined)).toBe(false);
  });

  it('extracts clientId and clientSecret and applies default scopes when GoogleOAuthCredentialsImpl has empty scopes', () => {
    const oauth2Creds = new GoogleOAuthCredentialsImpl({
      token: 'test-token',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      scopes: [],
    });

    const config = new SpannerCredentialsConfig({credentials: oauth2Creds});

    expect(config.credentials).toBe(oauth2Creds);
    expect(config.clientId).toBe('test-client-id');
    expect(config.clientSecret).toBe('test-client-secret');
    expect(config.scopes).toEqual([...SPANNER_DEFAULT_SCOPE]);
    expect(config.tokenCacheKey).toBe(SPANNER_TOKEN_CACHE_KEY);
  });

  it('preserves non-empty scopes from pre-existing OAuth credentials', () => {
    const oauth2Creds = new GoogleOAuthCredentialsImpl({
      token: 'test-token',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      scopes: ['https://www.googleapis.com/auth/spanner.data'],
    });

    const config = new SpannerCredentialsConfig({credentials: oauth2Creds});

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/spanner.data',
    ]);
  });

  it('configures clientId and clientSecret with default, empty, and custom scopes', () => {
    const withDefaultScopes = new SpannerCredentialsConfig({
      clientId: 'clientOne',
      clientSecret: 'secretOne',
    });
    expect(withDefaultScopes.scopes).toEqual([...SPANNER_DEFAULT_SCOPE]);
    expect(withDefaultScopes.tokenCacheKey).toBe(SPANNER_TOKEN_CACHE_KEY);

    const withEmptyScopes = new SpannerCredentialsConfig({
      clientId: 'clientOne',
      clientSecret: 'secretOne',
      scopes: [],
    });
    expect(withEmptyScopes.scopes).toEqual([...SPANNER_DEFAULT_SCOPE]);

    const customScopes = ['https://www.googleapis.com/auth/spanner.data'];
    const withCustomScopes = new SpannerCredentialsConfig({
      clientId: 'clientOne',
      clientSecret: 'secretOne',
      scopes: customScopes,
      tokenCacheKey: 'customSpannerCache',
    });
    customScopes.length = 0;
    expect(withCustomScopes.scopes).toEqual([
      'https://www.googleapis.com/auth/spanner.data',
    ]);
    expect(withCustomScopes.tokenCacheKey).toBe('customSpannerCache');
  });

  it('configures externalAccessTokenKey with default scopes and supports empty scopes', () => {
    const config = new SpannerCredentialsConfig({
      externalAccessTokenKey: 'spannerTokenKey',
    });
    expect(config.externalAccessTokenKey).toBe('spannerTokenKey');
    expect(config.scopes).toEqual([...SPANNER_DEFAULT_SCOPE]);
    expect(config.tokenCacheKey).toBe(SPANNER_TOKEN_CACHE_KEY);

    const withEmptyScopes = new SpannerCredentialsConfig({
      externalAccessTokenKey: 'spannerTokenKey',
      scopes: [],
    });
    expect(withEmptyScopes.scopes).toEqual([...SPANNER_DEFAULT_SCOPE]);
  });

  it('enforces mutual exclusivity and validates required non-empty credential options', () => {
    expect(() => new SpannerCredentialsConfig()).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(() => new SpannerCredentialsConfig({clientId: 'onlyId'})).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () => new SpannerCredentialsConfig({clientSecret: 'onlySecret'}),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () =>
        new SpannerCredentialsConfig({
          clientId: '',
          clientSecret: 'secretOne',
        }),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () =>
        new SpannerCredentialsConfig({
          externalAccessTokenKey: '',
        }),
    ).toThrow(/externalAccessTokenKey must be a non-empty string/);
    expect(
      () =>
        new SpannerCredentialsConfig({
          credentials: {token: 'tok'},
          scopes: ['https://www.googleapis.com/auth/spanner.data'],
        }),
    ).toThrow(
      /If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided/,
    );
    expect(
      () =>
        new SpannerCredentialsConfig({
          credentials: {token: 'tok'},
          externalAccessTokenKey: 'extKey',
        }),
    ).toThrow(
      /If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided/,
    );
    expect(
      () =>
        new SpannerCredentialsConfig({
          externalAccessTokenKey: 'extKey',
          scopes: ['https://www.googleapis.com/auth/spanner.data'],
        }),
    ).toThrow(
      /If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided/,
    );
  });

  it('works with GoogleCredentialsManager for JWT, OAuth2Client, GoogleAuth, and OAuth token caching', async () => {
    const jwtClient = new JWT({
      email: 'service-account@example.iam.gserviceaccount.com',
      scopes: [...SPANNER_DEFAULT_SCOPE],
    });
    const oauth2Client = new OAuth2Client({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    const googleAuth = new GoogleAuth({
      scopes: [...SPANNER_DEFAULT_SCOPE],
    });

    const authClients: GoogleCredentials[] = [
      jwtClient,
      oauth2Client,
      googleAuth,
    ];
    for (const authClient of authClients) {
      const cfg = new SpannerCredentialsConfig({credentials: authClient});
      expect(cfg.scopes).toEqual([...SPANNER_DEFAULT_SCOPE]);
      const manager = new GoogleCredentialsManager(cfg);
      const {context, getAuthResponse, requestCredential} =
        createMockToolContext();
      const resolved = await manager.getValidCredentials(context);
      expect(resolved).toBe(authClient);
      expect(getAuthResponse).not.toHaveBeenCalled();
      expect(requestCredential).not.toHaveBeenCalled();
    }

    const plainTokenCreds: GoogleCredentials = {token: 'plain-spanner-token'};
    const plainTokenManager = new GoogleCredentialsManager(
      new SpannerCredentialsConfig({credentials: plainTokenCreds}),
    );
    const {context: plainCtx, requestCredential: plainReq} =
      createMockToolContext();
    expect(await plainTokenManager.getValidCredentials(plainCtx)).toBe(
      plainTokenCreds,
    );
    expect(plainReq).not.toHaveBeenCalled();

    const oauthConfig = new SpannerCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    const oauthManager = new GoogleCredentialsManager(oauthConfig);
    const {context, getAuthResponse, state} = createMockToolContext();
    getAuthResponse.mockReturnValue({
      oauth2: {
        accessToken: 'spanner-access-token',
        refreshToken: 'spanner-refresh-token',
      },
    });

    const resolved = await oauthManager.getValidCredentials(context);
    expect(resolved).toBeDefined();
    expect(state.get<string>(SPANNER_TOKEN_CACHE_KEY)).toContain(
      'spanner-access-token',
    );
  });
});
