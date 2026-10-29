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
  BigQueryCredentialsConfig,
  BigQueryOAuthCredentials,
  type GoogleOAuthCredentials,
  isBigQueryCredentialsConfig,
} from '@google/adk-integrations';
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

  it('test_valid_credentials_object', () => {
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

  it('test_valid_credentials_object_auth_credentials', () => {
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
    const emptyScopeCreds: GoogleOAuthCredentials = {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: [],
    };

    const config = new BigQueryCredentialsConfig({
      credentials: emptyScopeCreds,
    });

    expect(config.credentials).toBe(emptyScopeCreds);
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });

  it('test_valid_credentials_object_oauth2_credentials', () => {
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

  it('test_valid_client_id_secret_pair', () => {
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

  it('test_valid_client_id_secret_pair_default_scope', () => {
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

  it('test_valid_client_id_secret_pair_w_scope', () => {
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

  it('test_valid_client_id_secret_pair_w_empty_scope', () => {
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

  it('test_missing_client_secret_raises_error', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientId: 'test_client_id'}),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  it('test_missing_client_id_raises_error', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientSecret: 'test_client_secret'}),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  it('test_empty_configuration_raises_error', () => {
    expect(() => new BigQueryCredentialsConfig({})).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(() => new BigQueryCredentialsConfig()).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
  });

  it('test_invalid_property_raises_error', () => {
    const invalidOptions = {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      non_existent_field: 'some value',
    };
    expect(() => new BigQueryCredentialsConfig(invalidOptions)).toThrow(
      /Unexpected property 'non_existent_field'/,
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

  it('test_get_valid_credentials_with_valid_existing_creds', async () => {
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

  it('test_get_credentials_from_cache_when_none_in_manager', async () => {
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

  it('test_no_credentials_in_manager_or_cache', async () => {
    const manager = createManager();
    const {context, requestCredential} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBeNull();
    expect(requestCredential).toHaveBeenCalledOnce();
  });

  it('test_refresh_cached_credentials_success', async () => {
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

  it('test_get_valid_credentials_with_refresh_success', async () => {
    const manager = createManager();
    const {context} = createMockToolContext();

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
  });

  it('test_get_valid_credentials_with_refresh_failure', async () => {
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

    expect(result).toBeNull();
    expect(requestCredential).toHaveBeenCalledOnce();
  });

  it('test_oauth_flow_completion_with_caching', async () => {
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

  it('test_oauth_flow_in_progress', async () => {
    const manager = createManager();
    const {context, requestCredential} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBeNull();
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

  it('test_cache_persistence_across_manager_instances', async () => {
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

    const result1 = await manager1.getValidCredentials(context);
    expect(result1?.token).toBe('cached_access_token');
    const cachedCredsJson = state.get<string>(BIGQUERY_TOKEN_CACHE_KEY);
    expect(cachedCredsJson).toBeDefined();

    const manager2 = new GoogleCredentialsManager(credentialsConfig);
    getAuthResponse.mockReturnValue(undefined);

    const fromJsonSpy = vi.spyOn(manager2, 'fromAuthorizedUserInfo');
    const result2 = await manager2.getValidCredentials(context);

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

    const creds = await manager.getValidCredentials(contextWithToken);
    expect(creds?.token).toBe('ext_token_123');
    expect(creds?.valid).toBe(true);

    const {context: emptyContext} = createMockToolContext();
    await expect(manager.getValidCredentials(emptyContext)).rejects.toThrow(
      /externalAccessTokenKey is provided but no access token found in toolContext\.state with key external_bq_token/,
    );
  });
});
