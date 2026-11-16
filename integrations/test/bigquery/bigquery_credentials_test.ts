/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type AuthConfig, type Context, State} from '@google/adk';
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
import {describe, expect, it, vi} from 'vitest';

import {GoogleCredentialsManager} from '../../src/bigquery/bigquery_credentials.js';

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
    expect(isBigQueryCredentialsConfig({})).toBe(false);
    expect(isBigQueryCredentialsConfig(null)).toBe(false);
    expect(isBigQueryCredentialsConfig(undefined)).toBe(false);
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

  // reference: test_valid_credentials_object
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

  // reference: test_valid_credentials_object_auth_credentials
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

  // reference: test_valid_credentials_object_oauth2_credentials
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

  // reference: test_valid_client_id_secret_pair
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

  // reference: test_valid_client_id_secret_pair_default_scope
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

  // reference: test_valid_client_id_secret_pair_w_scope
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

  // reference: test_valid_client_id_secret_pair_w_empty_scope
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

  // reference: test_missing_client_secret_raises_error
  it('throws when clientSecret is missing', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientId: 'test_client_id'}),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  // reference: test_missing_client_id_raises_error
  it('throws when clientId is missing', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientSecret: 'test_client_secret'}),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  // reference: test_empty_configuration_raises_error
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

  it('accepts an empty-string clientId and clientSecret pair', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: '',
      clientSecret: '',
    });
    expect(config.clientId).toBe('');
    expect(config.clientSecret).toBe('');
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
  function createManager(): GoogleCredentialsManager {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    return new GoogleCredentialsManager(config);
  }

  // reference: test_get_valid_credentials_with_valid_existing_creds
  it('returns valid configured credentials without the OAuth2 flow', async () => {
    const manager = createManager();
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();

    const mockCreds: GoogleOAuthCredentials = {valid: true};
    manager.credentialsConfig.credentials = mockCreds;

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  // reference: test_get_credentials_from_cache_when_none_in_manager
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

    const mockCreds: GoogleOAuthCredentials = {valid: true};
    const fromJsonSpy = vi
      .spyOn(manager, 'fromAuthorizedUserInfo')
      .mockReturnValue(mockCreds);

    const result = await manager.getValidCredentials(context);

    expect(fromJsonSpy).toHaveBeenCalledOnce();
    expect(fromJsonSpy).toHaveBeenCalledWith(
      JSON.parse(mockCachedCredsJson),
      manager.credentialsConfig.scopes,
    );
    expect(manager.credentialsConfig.credentials).toBeUndefined();
    expect(result).toBe(mockCreds);
    fromJsonSpy.mockRestore();
  });

  // reference: test_no_credentials_in_manager_or_cache
  it('requests credentials when none are configured or cached', async () => {
    const manager = createManager();
    const {context, requestCredential} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledOnce();
  });

  // reference: test_refresh_cached_credentials_success
  it('refreshes expired cached credentials and updates the cache', async () => {
    const manager = createManager();
    const mockCachedCredsJson = JSON.stringify({
      token: 'expired_token',
      refresh_token: 'valid_refresh_token',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
    });
    const mockRefreshedCredsJson = JSON.stringify({
      token: 'new_token',
      refresh_token: 'valid_refresh_token',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
    });
    const {context, state} = createMockToolContext({
      [BIGQUERY_TOKEN_CACHE_KEY]: mockCachedCredsJson,
    });

    const mockCachedCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'valid_refresh_token',
      toJson: vi.fn(() => mockRefreshedCredsJson),
    };
    mockCachedCreds.refresh = vi.fn(async () => {
      mockCachedCreds.valid = true;
    });

    const fromJsonSpy = vi
      .spyOn(manager, 'fromAuthorizedUserInfo')
      .mockReturnValue(mockCachedCreds);

    const result = await manager.getValidCredentials(context);

    expect(fromJsonSpy).toHaveBeenCalledOnce();
    expect(fromJsonSpy).toHaveBeenCalledWith(
      JSON.parse(mockCachedCredsJson),
      manager.credentialsConfig.scopes,
    );
    expect(mockCachedCreds.refresh).toHaveBeenCalledOnce();
    expect(manager.credentialsConfig.credentials).toBeUndefined();
    const cachedAfter = JSON.parse(
      state.get<string>(BIGQUERY_TOKEN_CACHE_KEY) ?? '{}',
    ) as Record<string, unknown>;
    expect(cachedAfter['token']).toBe('new_token');
    expect(result).toBe(mockCachedCreds);
    fromJsonSpy.mockRestore();
  });

  // reference: test_get_valid_credentials_with_refresh_success
  it('refreshes expired configured credentials', async () => {
    const manager = createManager();
    const {context, state} = createMockToolContext();

    const mockCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'refresh_token',
    };
    mockCreds.refresh = vi.fn(async () => {
      mockCreds.valid = true;
    });
    manager.credentialsConfig.credentials = mockCreds;

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(mockCreds.refresh).toHaveBeenCalledOnce();
    expect(manager.credentialsConfig.credentials).toBe(mockCreds);
    expect(state.get(BIGQUERY_TOKEN_CACHE_KEY)).toBeUndefined();
  });

  // reference: test_get_valid_credentials_with_existing_non_oauth_creds
  it('refreshes credentials without a validity flag once and skips the OAuth2 flow', async () => {
    const manager = createManager();
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();

    const mockCreds: GoogleOAuthCredentials = {refresh: vi.fn(async () => {})};
    manager.credentialsConfig.credentials = mockCreds;

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(mockCreds.refresh).toHaveBeenCalledOnce();
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  // reference: test_get_valid_credentials_with_non_oauth_refresh_failure
  it('returns credentials without a validity flag when their refresh fails', async () => {
    const manager = createManager();
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();

    const mockCreds: GoogleOAuthCredentials = {
      refresh: vi.fn(async () => {
        throw new Error('Refresh failed');
      }),
    };
    manager.credentialsConfig.credentials = mockCreds;

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(mockCreds.refresh).toHaveBeenCalledOnce();
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  // reference: test_get_valid_credentials_with_refresh_failure
  it('starts the OAuth2 flow when refresh fails', async () => {
    const manager = createManager();
    const {context, requestCredential} = createMockToolContext();

    const mockCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'expired_refresh_token',
      refresh: vi.fn(async () => {
        throw new Error('Refresh failed');
      }),
    };
    manager.credentialsConfig.credentials = mockCreds;

    const result = await manager.getValidCredentials(context);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledOnce();
  });

  // reference: test_oauth_flow_completion_with_caching
  it('caches credentials from a completed OAuth2 flow', async () => {
    const manager = createManager();
    const {context, getAuthResponse, state} = createMockToolContext();

    getAuthResponse.mockReturnValue({
      oauth2: {
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token',
      },
    });

    const mockCredsJson = JSON.stringify({
      token: 'new_access_token',
      refresh_token: 'new_refresh_token',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const mockCreds: GoogleOAuthCredentials = {
      token: 'new_access_token',
      refreshToken: 'new_refresh_token',
      valid: true,
      toJson: () => mockCredsJson,
    };

    const createCredsSpy = vi
      .spyOn(manager, 'createOAuthCredentials')
      .mockReturnValue(mockCreds);

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(createCredsSpy).toHaveBeenCalledOnce();
    expect(createCredsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'new_access_token',
        refreshToken: 'new_refresh_token',
      }),
    );
    expect(manager.credentialsConfig.credentials).toBeUndefined();
    expect(state.get<string>(BIGQUERY_TOKEN_CACHE_KEY)).toBe(mockCredsJson);
    createCredsSpy.mockRestore();
  });

  // reference: test_oauth_flow_in_progress
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

  // reference: test_cache_persistence_across_manager_instances
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

    const result1 = (await manager1.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;
    expect(result1?.token).toBe('cached_access_token');
    const cachedCredsJson = state.get<string>(BIGQUERY_TOKEN_CACHE_KEY);
    expect(cachedCredsJson).toBeDefined();

    const manager2 = new GoogleCredentialsManager(credentialsConfig);
    getAuthResponse.mockReturnValue(undefined);

    const fromJsonSpy = vi.spyOn(manager2, 'fromAuthorizedUserInfo');
    const result2 = (await manager2.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;

    expect(result2?.token).toBe('cached_access_token');
    expect(result2?.refreshToken).toBe('cached_refresh_token');
    expect(manager2.credentialsConfig.credentials).toBeUndefined();
    expect(state.get<string>(BIGQUERY_TOKEN_CACHE_KEY)).toBe(cachedCredsJson);
    expect(fromJsonSpy).toHaveBeenCalledOnce();
    const actualData = fromJsonSpy.mock.calls[0]?.[0];
    expect(actualData).toEqual(JSON.parse(cachedCredsJson ?? '{}'));
    fromJsonSpy.mockRestore();
  });

  it('resolves credentials from externalAccessTokenKey when configured', async () => {
    const config = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'external_bq_token',
    });
    const manager = new GoogleCredentialsManager(config);
    const {context: contextWithToken} = createMockToolContext({
      external_bq_token: 'ext_token_123',
    });

    const creds = (await manager.getValidCredentials(contextWithToken)) as
      GoogleOAuthCredentials | undefined;
    expect(creds?.token).toBe('ext_token_123');
    expect(creds?.valid).toBe(true);

    const {context: emptyContext} = createMockToolContext();
    await expect(manager.getValidCredentials(emptyContext)).rejects.toThrow(
      /externalAccessTokenKey is provided but no access token found in toolContext\.state with key external_bq_token/,
    );
  });

  it('marks credentials from fromAuthorizedUserInfo expired when expiry is in the past or within the 60s leeway', () => {
    const manager = createManager();
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const withinLeewayIso = new Date(Date.now() + 30_000).toISOString();
    const futureIso = new Date(Date.now() + 120_000).toISOString();

    const expiredCreds = manager.fromAuthorizedUserInfo({
      token: 'expired_access_token',
      refresh_token: 'refresh_token_1',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      expiry: pastIso,
    });
    expect(expiredCreds.expiry).toBe(pastIso);
    expect(expiredCreds.expired).toBe(true);
    expect(expiredCreds.valid).toBe(false);

    const nearExpiryCreds = manager.fromAuthorizedUserInfo({
      token: 'near_expiry_access_token',
      refresh_token: 'refresh_token_1',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      expiry: withinLeewayIso,
    });
    expect(nearExpiryCreds.expiry).toBe(withinLeewayIso);
    expect(nearExpiryCreds.expired).toBe(true);
    expect(nearExpiryCreds.valid).toBe(false);

    const validCreds = manager.fromAuthorizedUserInfo({
      token: 'valid_access_token',
      refresh_token: 'refresh_token_1',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      expiry: futureIso,
    });
    expect(validCreds.expiry).toBe(futureIso);
    expect(validCreds.expired).toBe(false);
    expect(validCreds.valid).toBe(true);
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

    const refreshedCreds = (await manager.getValidCredentials(
      context,
    )) as GoogleOAuthCredentials;
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

    const initialCreds = (await manager.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;
    expect(initialCreds?.expiry).toBe(new Date(pastExpiresAt).toISOString());
    expect(initialCreds?.expired).toBe(true);
    expect(initialCreds?.valid).toBe(false);

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

    const refreshedCreds = (await manager.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(refreshedCreds?.token).toBe('refreshed_token');
    expect(refreshedCreds?.expired).toBe(false);
    expect(refreshedCreds?.valid).toBe(true);
    expect(Date.parse(refreshedCreds?.expiry ?? '')).toBeGreaterThanOrEqual(
      futureExpiresAt - 5_000,
    );

    const cachedAfterRefresh = JSON.parse(
      state.get<string>(BIGQUERY_TOKEN_CACHE_KEY) ?? '{}',
    ) as Record<string, unknown>;
    expect(cachedAfterRefresh['token']).toBe('refreshed_token');
    expect(cachedAfterRefresh['expiry']).toBe(refreshedCreds?.expiry);
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
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();
    const resolved = await manager.getValidCredentials(context);
    expect(resolved).toBe(jwtClient);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });
});
