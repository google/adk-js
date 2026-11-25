/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type AuthConfig,
  type Context,
  GoogleCredentialsManager,
  GoogleOAuthRefreshError,
  isBaseGoogleCredentialsConfig,
  isGoogleAuthClient,
  isGoogleCredentialsManager,
  isGoogleOAuthCredentialsImpl,
  State,
} from '@google/adk';
import {
  BIGQUERY_DEFAULT_SCOPE,
  BIGQUERY_SCOPES,
  BIGQUERY_TOKEN_CACHE_KEY,
  type BigQueryAuthClient,
  type BigQueryCredentials,
  BigQueryCredentialsConfig,
  BigQueryOAuthCredentials,
  getBigQueryClient,
  type GoogleOAuthCredentials,
  isBigQueryAuthClient,
  isBigQueryCredentialsConfig,
} from '@google/adk-integrations';
import {GoogleAuth, JWT, OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';

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

describe('BigQueryCredentialsConfig', () => {
  it('identifies BigQueryCredentialsConfig instances via isBigQueryCredentialsConfig', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });
    expect(isBigQueryCredentialsConfig(config)).toBe(true);
    expect(isBaseGoogleCredentialsConfig(config)).toBe(true);
    expect(config.tokenCacheKey).toBe(BIGQUERY_TOKEN_CACHE_KEY);
    expect(isBigQueryCredentialsConfig({})).toBe(false);
    expect(isBigQueryCredentialsConfig(null)).toBe(false);
    expect(isBigQueryCredentialsConfig(undefined)).toBe(false);

    const oauthCreds = new BigQueryOAuthCredentials({token: 'tok'});
    expect(isGoogleOAuthCredentialsImpl(oauthCreds)).toBe(true);
  });

  it('exposes default scope constants', () => {
    expect(BIGQUERY_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigquery',
    ]);
    expect(BIGQUERY_SCOPES).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('copies clientId, clientSecret, and scopes from credentials', () => {
    const mockCreds: GoogleOAuthCredentials = {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    };

    const config = new BigQueryCredentialsConfig({credentials: mockCreds});

    expect(config.credentials).toBe(mockCreds);
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
  });

  it('uses default scopes for credentials without scopes', () => {
    const authCreds: GoogleOAuthCredentials = {
      valid: true,
    };

    const config = new BigQueryCredentialsConfig({credentials: authCreds});

    expect(config.credentials).toBe(authCreds);
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('defaults scopes when credentials.scopes is empty', () => {
    const credentials: GoogleOAuthCredentials = {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: [],
    };

    const config = new BigQueryCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });

  it('accepts BigQueryOAuthCredentials as credentials', () => {
    const oauth2Creds = new BigQueryOAuthCredentials({
      token: 'test_token',
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const config = new BigQueryCredentialsConfig({credentials: oauth2Creds});

    expect(config.credentials).toBe(oauth2Creds);
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
  });

  it('accepts a clientId and clientSecret pair with scopes', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/bigquery'],
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/bigquery']);
  });

  it('uses default scopes when scopes are omitted', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('keeps custom scopes for a clientId and clientSecret pair', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: [
        'https://www.googleapis.com/auth/bigquery',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/drive',
    ]);
  });

  it('uses default scopes when scopes are empty', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: [],
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('throws when clientSecret is missing', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientId: 'test_client_id'}),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  it('throws when clientId is missing', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientSecret: 'test_client_secret'}),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  it('throws when no credential source is configured', () => {
    expect(() => new BigQueryCredentialsConfig({})).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(() => new BigQueryCredentialsConfig()).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  it('accepts empty scopes alongside credentials or externalAccessTokenKey', () => {
    const credentialsConfig = new BigQueryCredentialsConfig({
      credentials: {token: 'tok'},
      scopes: [],
    });
    expect(credentialsConfig.scopes).toEqual([...BIGQUERY_SCOPES]);

    const externalTokenConfig = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'my_token_key',
      scopes: [],
    });
    expect(externalTokenConfig.scopes).toEqual([...BIGQUERY_SCOPES]);
  });

  it('rejects empty or whitespace clientId and clientSecret values', () => {
    expect(
      () =>
        new BigQueryCredentialsConfig({
          clientId: '',
          clientSecret: '',
        }),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () =>
        new BigQueryCredentialsConfig({
          clientId: '   ',
          clientSecret: 'testSecret',
        }),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () =>
        new BigQueryCredentialsConfig({
          clientId: 'testClient',
          clientSecret: '   ',
        }),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  it('rejects mutually exclusive credential options', () => {
    expect(
      () =>
        new BigQueryCredentialsConfig({
          credentials: {token: 'tok'},
          clientId: 'id',
          clientSecret: 'secret',
        }),
    ).toThrow(
      /If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided/,
    );

    expect(
      () =>
        new BigQueryCredentialsConfig({
          externalAccessTokenKey: 'my_token_key',
          clientId: 'id',
          clientSecret: 'secret',
        }),
    ).toThrow(
      /If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided/,
    );

    expect(
      () =>
        new BigQueryCredentialsConfig({
          credentials: {token: 'tok'},
          scopes: ['https://www.googleapis.com/auth/bigquery'],
        }),
    ).toThrow(/If credentials are provided/);
  });
});

describe('GoogleCredentialsManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createManager(): GoogleCredentialsManager {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    return new GoogleCredentialsManager(config);
  }

  function createManagerWithCredentials(
    credentials: BigQueryCredentials,
  ): GoogleCredentialsManager {
    return new GoogleCredentialsManager(
      new BigQueryCredentialsConfig({credentials}),
    );
  }

  function expectOAuthCredentials(
    credentials: BigQueryCredentials | undefined,
  ): GoogleOAuthCredentials {
    if (!credentials || isGoogleAuthClient(credentials)) {
      throw new Error('Expected GoogleOAuthCredentials');
    }
    return credentials;
  }

  it('returns valid configured credentials without the OAuth2 flow', async () => {
    const mockCreds: GoogleOAuthCredentials = {valid: true};
    const manager = createManagerWithCredentials(mockCreds);
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('loads credentials from the session cache', async () => {
    const manager = createManager();
    const mockCachedCredsJson = JSON.stringify({
      token: 'cached_token',
      refresh_token: 'cached_refresh_token',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
    });
    const {context} = createMockToolContext({
      [BIGQUERY_TOKEN_CACHE_KEY]: mockCachedCredsJson,
    });

    const rawResult = await manager.getValidCredentials(context);
    expect(isGoogleOAuthCredentialsImpl(rawResult)).toBe(true);
    const result = expectOAuthCredentials(rawResult);

    expect(result.token).toBe('cached_token');
    expect(result.refreshToken).toBe('cached_refresh_token');
    expect(result.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
    expect(result.valid).toBe(true);
    expect(manager.credentialsConfig.credentials).toBeUndefined();
  });

  it('requests credentials when none are configured or cached', async () => {
    const manager = createManager();
    const {context, requestCredential} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledOnce();
  });

  it('refreshes expired cached credentials and updates the cache', async () => {
    const manager = createManager();
    const mockCachedCredsJson = JSON.stringify({
      token: 'expired_token',
      refresh_token: 'valid_refresh_token',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      expiry: new Date(Date.now() - 10_000).toISOString(),
    });
    const {context, state} = createMockToolContext({
      [BIGQUERY_TOKEN_CACHE_KEY]: mockCachedCredsJson,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new_token',
          expires_in: 3600,
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      ),
    );

    const result = expectOAuthCredentials(
      await manager.getValidCredentials(context),
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.token).toBe('new_token');
    expect(result.valid).toBe(true);
    expect(manager.credentialsConfig.credentials).toBeUndefined();
    const cachedAfter = JSON.parse(
      state.get<string>(BIGQUERY_TOKEN_CACHE_KEY) ?? '{}',
    ) as Record<string, unknown>;
    expect(cachedAfter['token']).toBe('new_token');
  });

  it('refreshes expired configured credentials', async () => {
    const mockCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'refresh_token',
    };
    mockCreds.refresh = vi.fn(async () => {
      mockCreds.valid = true;
    });
    const manager = createManagerWithCredentials(mockCreds);
    const {context, state} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(mockCreds.refresh).toHaveBeenCalledOnce();
    expect(manager.credentialsConfig.credentials).toBe(mockCreds);
    expect(state.get(BIGQUERY_TOKEN_CACHE_KEY)).toBeUndefined();
  });

  it('refreshes credentials without a validity flag once and skips the OAuth2 flow', async () => {
    const mockCreds: GoogleOAuthCredentials = {refresh: vi.fn(async () => {})};
    const manager = createManagerWithCredentials(mockCreds);
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(mockCreds.refresh).toHaveBeenCalledOnce();
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('returns credentials without a validity flag when their refresh fails', async () => {
    const mockCreds: GoogleOAuthCredentials = {
      refresh: vi.fn(async () => {
        throw new Error('Refresh failed');
      }),
    };
    const manager = createManagerWithCredentials(mockCreds);
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(mockCreds.refresh).toHaveBeenCalledOnce();
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('accepts plain token credentials and refreshes expired non-OAuth credentials without starting the OAuth2 flow', async () => {
    const plainTokenCreds: GoogleOAuthCredentials = {token: 'plainToken'};
    const plainManager = createManagerWithCredentials(plainTokenCreds);
    const {context: plainContext, requestCredential: plainRequest} =
      createMockToolContext();
    expect(await plainManager.getValidCredentials(plainContext)).toBe(
      plainTokenCreds,
    );
    expect(plainRequest).not.toHaveBeenCalled();

    const expiredNonOAuthCreds: GoogleOAuthCredentials = {
      token: 'oldToken',
      valid: false,
      expired: true,
      refresh: vi.fn(async () => {
        expiredNonOAuthCreds.token = 'refreshedToken';
        expiredNonOAuthCreds.valid = true;
        expiredNonOAuthCreds.expired = false;
      }),
    };
    const nonOAuthManager = createManagerWithCredentials(expiredNonOAuthCreds);
    const {context: nonOAuthContext, requestCredential: nonOAuthRequest} =
      createMockToolContext();
    expect(await nonOAuthManager.getValidCredentials(nonOAuthContext)).toBe(
      expiredNonOAuthCreds,
    );
    expect(expiredNonOAuthCreds.refresh).toHaveBeenCalledOnce();
    expect(nonOAuthRequest).not.toHaveBeenCalled();
  });

  it('starts the OAuth2 flow when refresh throws GoogleOAuthRefreshError', async () => {
    const mockCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'expired_refresh_token',
      refresh: vi.fn(async () => {
        throw new GoogleOAuthRefreshError('Refresh failed', {status: 400});
      }),
    };
    const manager = createManagerWithCredentials(mockCreds);
    const {context, requestCredential} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledOnce();
  });

  it('propagates non-GoogleOAuthRefreshError errors from OAuth token refresh', async () => {
    const mockCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'refreshToken1',
      refresh: vi.fn(async () => {
        throw new Error('Token endpoint unreachable');
      }),
    };
    const manager = createManagerWithCredentials(mockCreds);
    const {context, requestCredential} = createMockToolContext();

    await expect(manager.getValidCredentials(context)).rejects.toThrow(
      'Token endpoint unreachable',
    );
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('caches credentials from a completed OAuth2 flow', async () => {
    const manager = createManager();
    const {context, getAuthResponse, state} = createMockToolContext();

    getAuthResponse.mockReturnValue({
      oauth2: {
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token',
      },
    });

    const rawResult = await manager.getValidCredentials(context);
    expect(isGoogleOAuthCredentialsImpl(rawResult)).toBe(true);
    const result = expectOAuthCredentials(rawResult);

    expect(result.token).toBe('new_access_token');
    expect(result.refreshToken).toBe('new_refresh_token');
    expect(result.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
    expect(manager.credentialsConfig.credentials).toBeUndefined();
    const cached = state.get<string>(BIGQUERY_TOKEN_CACHE_KEY);
    expect(cached).toBeDefined();
    expect(JSON.parse(cached ?? '{}')).toEqual({
      token: 'new_access_token',
      refresh_token: 'new_refresh_token',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
  });

  it('requests OAuth2 credentials with the configured client', async () => {
    const manager = createManager();
    const {context, requestCredential} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledOnce();
    const requestedAuthConfig = requestCredential.mock
      .calls[0]?.[0] as AuthConfig;
    expect(requestedAuthConfig.authScheme.type).toBe('oauth2');
    expect(requestedAuthConfig.rawAuthCredential?.oauth2?.clientId).toBe(
      'test_client_id',
    );
    expect(requestedAuthConfig.rawAuthCredential?.oauth2?.clientSecret).toBe(
      'test_client_secret',
    );
  });

  it('shares cached credentials across manager instances', async () => {
    const credentialsConfig = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const {context, getAuthResponse, state} = createMockToolContext();

    const manager1 = new GoogleCredentialsManager(credentialsConfig);
    getAuthResponse.mockReturnValue({
      oauth2: {
        accessToken: 'cached_access_token',
        refreshToken: 'cached_refresh_token',
      },
    });

    const result1 = expectOAuthCredentials(
      await manager1.getValidCredentials(context),
    );
    expect(result1.token).toBe('cached_access_token');
    const cachedCredsJson = state.get<string>(BIGQUERY_TOKEN_CACHE_KEY);
    expect(cachedCredsJson).toBeDefined();

    const manager2 = new GoogleCredentialsManager(credentialsConfig);
    getAuthResponse.mockReturnValue(undefined);

    const rawResult2 = await manager2.getValidCredentials(context);
    expect(isGoogleOAuthCredentialsImpl(rawResult2)).toBe(true);
    const result2 = expectOAuthCredentials(rawResult2);

    expect(result2.token).toBe('cached_access_token');
    expect(result2.refreshToken).toBe('cached_refresh_token');
    expect(result2.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar',
    ]);
    expect(manager2.credentialsConfig.credentials).toBeUndefined();
    expect(state.get<string>(BIGQUERY_TOKEN_CACHE_KEY)).toBe(cachedCredsJson);
  });

  it('resolves credentials from externalAccessTokenKey when configured', async () => {
    const config = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'external_bq_token',
    });
    const manager = new GoogleCredentialsManager(config);
    const {context: contextWithToken} = createMockToolContext({
      external_bq_token: 'ext_token_123',
    });

    const creds = expectOAuthCredentials(
      await manager.getValidCredentials(contextWithToken),
    );
    expect(creds.token).toBe('ext_token_123');
    expect(creds.valid).toBe(true);

    const {context: emptyContext} = createMockToolContext();
    await expect(manager.getValidCredentials(emptyContext)).rejects.toThrow(
      /externalAccessTokenKey is provided but no access token found in toolContext\.state with key external_bq_token/,
    );
  });

  it('marks credentials expired when expiry is in the past or within the 60s leeway', async () => {
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const withinLeewayIso = new Date(Date.now() + 30_000).toISOString();
    const futureIso = new Date(Date.now() + 120_000).toISOString();

    const expiredCreds = new BigQueryOAuthCredentials({
      token: 'expiredAccessToken',
      refreshToken: 'refreshToken1',
      clientId: 'testClientId',
      clientSecret: 'testClientSecret',
      expiry: pastIso,
    });
    expect(expiredCreds.expiry).toBe(pastIso);
    expect(expiredCreds.expired).toBe(true);
    expect(expiredCreds.valid).toBe(false);

    const nearExpiryCreds = new BigQueryOAuthCredentials({
      token: 'nearExpiryAccessToken',
      refreshToken: 'refreshToken1',
      clientId: 'testClientId',
      clientSecret: 'testClientSecret',
      expiry: withinLeewayIso,
    });
    expect(nearExpiryCreds.expiry).toBe(withinLeewayIso);
    expect(nearExpiryCreds.expired).toBe(true);
    expect(nearExpiryCreds.valid).toBe(false);

    const validCreds = new BigQueryOAuthCredentials({
      token: 'validAccessToken',
      refreshToken: 'refreshToken1',
      clientId: 'testClientId',
      clientSecret: 'testClientSecret',
      expiry: futureIso,
    });
    expect(validCreds.expiry).toBe(futureIso);
    expect(validCreds.expired).toBe(false);
    expect(validCreds.valid).toBe(true);

    const manager = createManager();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const {context} = createMockToolContext({
      [BIGQUERY_TOKEN_CACHE_KEY]: JSON.stringify({
        token: 'validCachedToken',
        refresh_token: 'refreshToken1',
        client_id: 'test_client_id',
        client_secret: 'test_client_secret',
        expiry: futureIso,
      }),
    });
    const resolved = expectOAuthCredentials(
      await manager.getValidCredentials(context),
    );
    expect(resolved.token).toBe('validCachedToken');
    expect(resolved.expired).toBe(false);
    expect(resolved.valid).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes cached credentials when the token is 30s from expiry', async () => {
    const manager = createManager();
    const thirtySecondsFromNow = new Date(Date.now() + 30_000).toISOString();
    const cachedNearExpiryJson = JSON.stringify({
      token: 'expiring_soon_token',
      refresh_token: 'refresh_token_1',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      expiry: thirtySecondsFromNow,
    });
    const {context, state} = createMockToolContext({
      [BIGQUERY_TOKEN_CACHE_KEY]: cachedNearExpiryJson,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'refreshed_before_flight',
          expires_in: 3600,
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      ),
    );

    const refreshedCreds = expectOAuthCredentials(
      await manager.getValidCredentials(context),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(refreshedCreds.token).toBe('refreshed_before_flight');
    expect(refreshedCreds.expired).toBe(false);
    expect(refreshedCreds.valid).toBe(true);

    const cachedAfter = JSON.parse(
      state.get<string>(BIGQUERY_TOKEN_CACHE_KEY) ?? '{}',
    ) as Record<string, unknown>;
    expect(cachedAfter['token']).toBe('refreshed_before_flight');
    fetchSpy.mockRestore();
  });

  it('persists expiry from authResponse.oauth2.expiresAt and refreshes when expired', async () => {
    const manager = createManager();
    const pastExpiresAt = Date.now() - 10_000;
    const futureExpiresAt = Date.now() + 3_600_000;
    const {context, getAuthResponse, state} = createMockToolContext();

    getAuthResponse.mockReturnValue({
      oauth2: {
        accessToken: 'initial_token',
        refreshToken: 'refresh_token_1',
        expiresAt: pastExpiresAt,
      },
    });

    const initialCreds = expectOAuthCredentials(
      await manager.getValidCredentials(context),
    );
    expect(initialCreds.expiry).toBe(new Date(pastExpiresAt).toISOString());
    expect(initialCreds.expired).toBe(true);
    expect(initialCreds.valid).toBe(false);

    const cachedInitial = JSON.parse(
      state.get<string>(BIGQUERY_TOKEN_CACHE_KEY) ?? '{}',
    ) as Record<string, unknown>;
    expect(cachedInitial['expiry']).toBe(new Date(pastExpiresAt).toISOString());

    getAuthResponse.mockReturnValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'refreshed_token',
          expires_in: 3600,
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      ),
    );

    const refreshedCreds = expectOAuthCredentials(
      await manager.getValidCredentials(context),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(refreshedCreds.token).toBe('refreshed_token');
    expect(refreshedCreds.expired).toBe(false);
    expect(refreshedCreds.valid).toBe(true);
    expect(Date.parse(refreshedCreds.expiry ?? '')).toBeGreaterThanOrEqual(
      futureExpiresAt - 5_000,
    );

    const cachedAfterRefresh = JSON.parse(
      state.get<string>(BIGQUERY_TOKEN_CACHE_KEY) ?? '{}',
    ) as Record<string, unknown>;
    expect(cachedAfterRefresh['token']).toBe('refreshed_token');
    expect(cachedAfterRefresh['expiry']).toBe(refreshedCreds.expiry);
    fetchSpy.mockRestore();
  });

  it('returns getRequestHeaders-capable credentials without starting the OAuth2 flow', async () => {
    const authClientCreds: BigQueryAuthClient = {
      getRequestHeaders: async () => ({Authorization: 'Bearer from-client'}),
    };
    const config = new BigQueryCredentialsConfig({
      credentials: authClientCreds,
    });
    const manager = new GoogleCredentialsManager(config);
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();

    const result = await manager.getValidCredentials(context);
    expect(result).toBe(authClientCreds);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('accepts google-auth-library JWT, OAuth2Client, and GoogleAuth clients without type casts', async () => {
    const jwtClient = new JWT({
      email: 'service-account@example.iam.gserviceaccount.com',
      scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    });
    const oauth2Client = new OAuth2Client({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    const googleAuth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    });

    const jwtCreds: BigQueryCredentials = jwtClient;
    const oauthCreds: BigQueryCredentials = oauth2Client;
    const authCreds: BigQueryCredentials = googleAuth;
    expect(isBigQueryAuthClient(jwtCreds)).toBe(true);
    expect(isBigQueryAuthClient(oauthCreds)).toBe(true);
    expect(isBigQueryAuthClient(authCreds)).toBe(true);
    expect(isBigQueryAuthClient({token: 'tok'})).toBe(false);
    expect(isGoogleAuthClient(jwtCreds)).toBe(true);
    expect(isGoogleAuthClient(oauthCreds)).toBe(true);
    expect(isGoogleAuthClient(authCreds)).toBe(true);
    expect(isGoogleAuthClient({token: 'tok'})).toBe(false);

    const jwtConfig = new BigQueryCredentialsConfig({credentials: jwtClient});
    const oauthConfig = new BigQueryCredentialsConfig({
      credentials: oauth2Client,
    });
    const authConfig = new BigQueryCredentialsConfig({credentials: googleAuth});

    expect(jwtConfig.credentials).toBe(jwtClient);
    expect(jwtConfig.scopes).toEqual([...BIGQUERY_SCOPES]);
    expect(oauthConfig.credentials).toBe(oauth2Client);
    expect(authConfig.credentials).toBe(googleAuth);

    const bqClientFromJwt = getBigQueryClient({
      projectId: 'my-project',
      credentials: jwtClient,
    });
    const bqClientFromOAuth = getBigQueryClient({
      projectId: 'my-project',
      credentials: oauth2Client,
    });
    const bqClientFromGoogleAuth = getBigQueryClient({
      projectId: 'my-project',
      credentials: googleAuth,
    });
    expect(bqClientFromJwt.credentials).toBe(jwtClient);
    expect(bqClientFromOAuth.credentials).toBe(oauth2Client);
    expect(bqClientFromGoogleAuth.credentials).toBe(googleAuth);

    const manager = new GoogleCredentialsManager(jwtConfig);
    expect(isGoogleCredentialsManager(manager)).toBe(true);
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();
    const resolved = await manager.getValidCredentials(context);
    expect(resolved).toBe(jwtClient);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });
});
