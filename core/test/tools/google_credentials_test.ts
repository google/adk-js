/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type AuthConfig,
  BaseGoogleCredentialsConfig,
  type Context,
  type GoogleAuthClient,
  type GoogleCredentials,
  GoogleCredentialsManager,
  type GoogleOAuthCredentials,
  GoogleOAuthCredentialsImpl,
  GoogleOAuthRefreshError,
  isBaseGoogleCredentialsConfig,
  isGoogleAuthClient,
  isGoogleCredentialsManager,
  isGoogleOAuthCredentialsImpl,
  isGoogleOAuthRefreshError,
  logger,
  State,
} from '@google/adk';
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

describe('BaseGoogleCredentialsConfig', () => {
  it('identifies instances via isBaseGoogleCredentialsConfig', () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'testClientId',
      clientSecret: 'testClientSecret',
    });

    expect(isBaseGoogleCredentialsConfig(config)).toBe(true);
    expect(isBaseGoogleCredentialsConfig({})).toBe(false);
    expect(isBaseGoogleCredentialsConfig(null)).toBe(false);
    expect(isBaseGoogleCredentialsConfig(undefined)).toBe(false);
  });

  it('copies clientId, clientSecret, and scopes from OAuth credentials', () => {
    const oauthCreds: GoogleOAuthCredentials = {
      clientId: 'oauthClientId',
      clientSecret: 'oauthClientSecret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    };

    const config = new BaseGoogleCredentialsConfig({
      credentials: oauthCreds,
      tokenCacheKey: 'googleTokenCache',
    });

    expect(config.credentials).toBe(oauthCreds);
    expect(config.clientId).toBe('oauthClientId');
    expect(config.clientSecret).toBe('oauthClientSecret');
    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
    expect(config.tokenCacheKey).toBe('googleTokenCache');
  });

  it('treats empty scopes as unset alongside credentials or externalAccessTokenKey', () => {
    const withCreds = new BaseGoogleCredentialsConfig({
      credentials: {valid: true},
      scopes: [],
    });
    expect(withCreds.scopes).toBeUndefined();

    const withExternalKey = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'externalAccessToken',
      scopes: [],
    });
    expect(withExternalKey.scopes).toBeUndefined();
  });

  it('accepts clientId and clientSecret with optional scopes', () => {
    const withoutScopes = new BaseGoogleCredentialsConfig({
      clientId: 'clientOne',
      clientSecret: 'secretOne',
    });
    expect(withoutScopes.scopes).toBeUndefined();
    expect(withoutScopes.tokenCacheKey).toBeUndefined();

    const withScopes = new BaseGoogleCredentialsConfig({
      clientId: 'clientOne',
      clientSecret: 'secretOne',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    expect(withScopes.scopes).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
    ]);
  });

  it('rejects empty or missing credential options and enforces mutual exclusivity', () => {
    expect(() => new BaseGoogleCredentialsConfig()).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(() => new BaseGoogleCredentialsConfig({clientId: 'onlyId'})).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () => new BaseGoogleCredentialsConfig({clientSecret: 'onlySecret'}),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          clientId: '',
          clientSecret: 'secretOne',
        }),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          clientId: 'clientOne',
          clientSecret: '   ',
        }),
    ).toThrow(
      /Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair/,
    );
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: '',
        }),
    ).toThrow(/externalAccessTokenKey must be a non-empty string/);
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: {token: 'tok'},
          externalAccessTokenKey: 'extKey',
        }),
    ).toThrow(
      /If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided/,
    );
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: {token: 'tok'},
          scopes: ['https://www.googleapis.com/auth/calendar'],
        }),
    ).toThrow(
      /If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided/,
    );
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'extKey',
          clientId: 'clientOne',
        }),
    ).toThrow(
      /If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided/,
    );
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'extKey',
          scopes: ['https://www.googleapis.com/auth/calendar'],
        }),
    ).toThrow(
      /If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided/,
    );
  });
});

describe('GoogleOAuthCredentialsImpl and GoogleOAuthRefreshError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('identifies instances via type guards', () => {
    const creds = new GoogleOAuthCredentialsImpl({token: 'tok'});
    const err = new GoogleOAuthRefreshError('Refresh rejected', {status: 400});

    expect(isGoogleOAuthCredentialsImpl(creds)).toBe(true);
    expect(isGoogleOAuthCredentialsImpl({})).toBe(false);
    expect(isGoogleOAuthCredentialsImpl(null)).toBe(false);

    expect(isGoogleOAuthRefreshError(err)).toBe(true);
    expect(err.status).toBe(400);
    expect(err.name).toBe('GoogleOAuthRefreshError');
    expect(isGoogleOAuthRefreshError(new Error('plain'))).toBe(false);
    expect(isGoogleOAuthRefreshError(null)).toBe(false);
  });

  it('applies the 60-second expiry leeway and respects explicit valid/expired overrides', () => {
    const withinLeeway = new GoogleOAuthCredentialsImpl({
      token: 'tok',
      expiry: Date.now() + 30_000,
    });
    expect(withinLeeway.expired).toBe(true);
    expect(withinLeeway.valid).toBe(false);

    const fresh = new GoogleOAuthCredentialsImpl({
      token: 'tok',
      expiry: new Date(Date.now() + 120_000),
    });
    expect(fresh.expired).toBe(false);
    expect(fresh.valid).toBe(true);

    fresh.expired = true;
    expect(fresh.expired).toBe(true);
    expect(fresh.valid).toBe(false);

    fresh.valid = true;
    expect(fresh.valid).toBe(true);
  });

  it('refreshes tokens via fetch and throws GoogleOAuthRefreshError on HTTP or payload failures', async () => {
    const creds = new GoogleOAuthCredentialsImpl({
      token: 'oldToken',
      refreshToken: 'refreshToken1',
      clientId: 'clientOne',
      clientSecret: 'secretOne',
      expiry: Date.now() - 10_000,
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'freshToken',
            refresh_token: 'refreshToken2',
            expires_in: 3600,
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        ),
      )
      .mockResolvedValueOnce(new Response('invalid_grant', {status: 400}))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({token_type: 'Bearer'}), {status: 200}),
      );

    await creds.refresh();
    expect(creds.token).toBe('freshToken');
    expect(creds.refreshToken).toBe('refreshToken2');
    expect(creds.valid).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    await expect(creds.refresh()).rejects.toThrow(GoogleOAuthRefreshError);
    await expect(creds.refresh()).rejects.toThrow(
      /Token refresh response did not contain access_token/,
    );
  });

  it('refreshes tokens via custom refreshHandler and validates missing refresh config', async () => {
    const missingRefreshToken = new GoogleOAuthCredentialsImpl({
      clientId: 'clientOne',
      clientSecret: 'secretOne',
    });
    await expect(missingRefreshToken.refresh()).rejects.toThrow(
      /Cannot refresh credentials without a refresh token/,
    );

    const missingClientCreds = new GoogleOAuthCredentialsImpl({
      refreshToken: 'refreshToken1',
    });
    await expect(missingClientCreds.refresh()).rejects.toThrow(
      /Cannot refresh credentials without clientId and clientSecret/,
    );

    const customCreds = new GoogleOAuthCredentialsImpl({
      token: 'oldToken',
      refreshHandler: async () => ({
        token: 'handlerToken',
        refreshToken: 'handlerRefreshToken',
        expiresIn: 1800,
      }),
    });
    await customCreds.refresh();
    expect(customCreds.token).toBe('handlerToken');
    expect(customCreds.refreshToken).toBe('handlerRefreshToken');
    expect(customCreds.valid).toBe(true);
  });
});

describe('GoogleCredentialsManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createManager(tokenCacheKey?: string): GoogleCredentialsManager {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'testClientId',
      clientSecret: 'testClientSecret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
      tokenCacheKey,
    });
    return new GoogleCredentialsManager(config);
  }

  it('identifies instances via isGoogleCredentialsManager', () => {
    const manager = createManager();
    expect(isGoogleCredentialsManager(manager)).toBe(true);
    expect(isGoogleCredentialsManager({})).toBe(false);
    expect(isGoogleCredentialsManager(null)).toBe(false);
  });

  it('returns valid configured credentials immediately without triggering OAuth flow', async () => {
    const mockCreds: GoogleOAuthCredentials = {valid: true};
    const config = new BaseGoogleCredentialsConfig({credentials: mockCreds});
    const manager = new GoogleCredentialsManager(config);
    const {context, getAuthResponse, requestCredential} =
      createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(mockCreds);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('handles non-OAuth credentials with a single refresh attempt when invalid and passes through on failure', async () => {
    const validNonOAuth: GoogleOAuthCredentials = {
      valid: true,
      refresh: vi.fn(async () => {}),
    };
    const {context} = createMockToolContext();

    const validManager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: validNonOAuth}),
    );
    expect(await validManager.getValidCredentials(context)).toBe(validNonOAuth);
    expect(validNonOAuth.refresh).not.toHaveBeenCalled();

    const invalidNonOAuth: GoogleOAuthCredentials = {
      valid: false,
      refresh: vi.fn(async () => {
        invalidNonOAuth.valid = true;
      }),
    };
    const invalidManager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: invalidNonOAuth}),
    );
    expect(await invalidManager.getValidCredentials(context)).toBe(
      invalidNonOAuth,
    );
    expect(invalidNonOAuth.refresh).toHaveBeenCalledOnce();

    const failingNonOAuth: GoogleOAuthCredentials = {
      valid: false,
      refresh: vi.fn(async () => {
        throw new Error('Refresh failed');
      }),
    };
    const failingManager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: failingNonOAuth}),
    );
    expect(await failingManager.getValidCredentials(context)).toBe(
      failingNonOAuth,
    );
    expect(failingNonOAuth.refresh).toHaveBeenCalledOnce();
  });

  it('refreshes expired non-OAuth credentials without entering OAuth flow', async () => {
    const expiredCreds: GoogleOAuthCredentials = {
      token: 'oldToken',
      valid: false,
      expired: true,
      refresh: vi.fn(async () => {
        expiredCreds.token = 'refreshedToken';
        expiredCreds.valid = true;
        expiredCreds.expired = false;
      }),
    };
    const {context: ctx1, requestCredential: req1} = createMockToolContext();
    const manager1 = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: expiredCreds}),
    );

    expect(await manager1.getValidCredentials(ctx1)).toBe(expiredCreds);
    expect(expiredCreds.refresh).toHaveBeenCalledOnce();
    expect(req1).not.toHaveBeenCalled();

    const failingExpiredCreds: GoogleOAuthCredentials = {
      token: 'oldToken',
      valid: false,
      expired: true,
      refresh: vi.fn(async () => {
        throw new Error('non-oauth refresh error');
      }),
    };
    const {context: ctx2, requestCredential: req2} = createMockToolContext();
    const manager2 = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: failingExpiredCreds}),
    );

    expect(await manager2.getValidCredentials(ctx2)).toBe(failingExpiredCreds);
    expect(failingExpiredCreds.refresh).toHaveBeenCalledOnce();
    expect(req2).not.toHaveBeenCalled();

    const omittedValidExpiredCreds: GoogleOAuthCredentials = {
      token: 'oldToken',
      expired: true,
      refresh: vi.fn(async () => {
        omittedValidExpiredCreds.token = 'refreshedToken2';
        omittedValidExpiredCreds.expired = false;
      }),
    };
    const {context: ctx3, requestCredential: req3} = createMockToolContext();
    const manager3 = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: omittedValidExpiredCreds}),
    );

    expect(await manager3.getValidCredentials(ctx3)).toBe(
      omittedValidExpiredCreds,
    );
    expect(omittedValidExpiredCreds.refresh).toHaveBeenCalledOnce();
    expect(req3).not.toHaveBeenCalled();
  });

  it('accepts plain token credential objects and computes expiry when valid and expired are omitted', async () => {
    const plainTokenCreds: GoogleOAuthCredentials = {token: 'abc'};
    const {context: ctx1, requestCredential: req1} = createMockToolContext();
    const manager1 = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: plainTokenCreds}),
    );

    expect(await manager1.getValidCredentials(ctx1)).toBe(plainTokenCreds);
    expect(req1).not.toHaveBeenCalled();

    const futureTokenCreds: GoogleOAuthCredentials = {
      token: 'abc',
      expiry: new Date(Date.now() + 120_000).toISOString(),
    };
    const {context: ctx2, requestCredential: req2} = createMockToolContext();
    const manager2 = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: futureTokenCreds}),
    );

    expect(await manager2.getValidCredentials(ctx2)).toBe(futureTokenCreds);
    expect(req2).not.toHaveBeenCalled();

    const nearExpiryOAuthCreds: GoogleOAuthCredentials = {
      token: 'staleToken',
      expiry: new Date(Date.now() + 30_000).toISOString(),
      refreshToken: 'refreshToken1',
      clientId: 'clientOne',
      clientSecret: 'secretOne',
      refresh: vi.fn(async () => {
        nearExpiryOAuthCreds.token = 'freshToken';
        nearExpiryOAuthCreds.expiry = new Date(
          Date.now() + 3_600_000,
        ).toISOString();
      }),
    };
    const {context: ctx3, requestCredential: req3} = createMockToolContext();
    const manager3 = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: nearExpiryOAuthCreds}),
    );

    expect(await manager3.getValidCredentials(ctx3)).toBe(nearExpiryOAuthCreds);
    expect(nearExpiryOAuthCreds.refresh).toHaveBeenCalledOnce();
    expect(nearExpiryOAuthCreds.token).toBe('freshToken');
    expect(req3).not.toHaveBeenCalled();

    const emptyTokenCreds: GoogleOAuthCredentials = {
      token: '',
      expiry: new Date(Date.now() + 120_000).toISOString(),
    };
    const {context: ctx4, requestCredential: req4} = createMockToolContext();
    const manager4 = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: emptyTokenCreds}),
    );

    expect(await manager4.getValidCredentials(ctx4)).toBeUndefined();
    expect(req4).toHaveBeenCalledOnce();
  });

  it('resolves credentials from externalAccessTokenKey and throws when missing', async () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'externalGoogleToken',
    });
    const manager = new GoogleCredentialsManager(config);
    const {context: populatedContext} = createMockToolContext({
      externalGoogleToken: 'extToken123',
    });

    const creds = (await manager.getValidCredentials(populatedContext)) as
      GoogleOAuthCredentials | undefined;
    expect(creds?.token).toBe('extToken123');
    expect(creds?.valid).toBe(true);

    const {context: emptyContext} = createMockToolContext();
    await expect(manager.getValidCredentials(emptyContext)).rejects.toThrow(
      /externalAccessTokenKey is provided but no access token found in toolContext\.state with key externalGoogleToken/,
    );
  });

  it('loads valid credentials from session cache when tokenCacheKey is configured', async () => {
    const manager = createManager('googleTokenCache');
    const cachedCredsJson = JSON.stringify({
      token: 'cachedToken',
      refresh_token: 'cachedRefreshToken',
      client_id: 'testClientId',
      client_secret: 'testClientSecret',
    });
    const {context} = createMockToolContext({
      googleTokenCache: cachedCredsJson,
    });

    const result = (await manager.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;

    expect(result?.token).toBe('cachedToken');
    expect(result?.refreshToken).toBe('cachedRefreshToken');
    expect(result?.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar',
    ]);
    expect(manager.credentialsConfig.credentials).toBeUndefined();
  });

  it('skips session cache reads and writes when tokenCacheKey is omitted', async () => {
    const manager = createManager();
    const {context, getAuthResponse, state} = createMockToolContext({
      googleTokenCache: JSON.stringify({
        token: 'shouldNotBeRead',
        refresh_token: 'rt',
      }),
    });

    getAuthResponse.mockReturnValue({
      oauth2: {
        accessToken: 'uncachedAccessToken',
        refreshToken: 'uncachedRefreshToken',
      },
    });

    const result = (await manager.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;

    expect(result?.token).toBe('uncachedAccessToken');
    expect(state.get<string>('googleTokenCache')).toContain('shouldNotBeRead');
  });

  it('recovers from corrupted cache JSON by logging a warning and falling back to OAuth flow', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const manager = createManager('googleTokenCache');
    const {context, requestCredential} = createMockToolContext({
      googleTokenCache: '{not-valid-json',
    });

    const result = await manager.getValidCredentials(context);

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(requestCredential).toHaveBeenCalledOnce();
  });

  it('refreshes expired cached credentials and updates session state', async () => {
    const manager = createManager('googleTokenCache');
    const expiredIso = new Date(Date.now() - 10_000).toISOString();
    const {context, state} = createMockToolContext({
      googleTokenCache: JSON.stringify({
        token: 'expiredToken',
        refresh_token: 'validRefreshToken',
        client_id: 'testClientId',
        client_secret: 'testClientSecret',
        expiry: expiredIso,
      }),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'refreshedToken',
          expires_in: 3600,
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      ),
    );

    const result = (await manager.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;

    expect(result?.token).toBe('refreshedToken');
    expect(result?.valid).toBe(true);
    const cachedAfter = JSON.parse(
      state.get<string>('googleTokenCache') ?? '{}',
    ) as Record<string, unknown>;
    expect(cachedAfter['token']).toBe('refreshedToken');
  });

  it('does not write developer-configured credentials into session state after refresh', async () => {
    const configuredCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'devRefreshToken',
      refresh: vi.fn(async () => {
        configuredCreds.valid = true;
        configuredCreds.token = 'refreshedDevToken';
      }),
    };
    const config = new BaseGoogleCredentialsConfig({
      credentials: configuredCreds,
      tokenCacheKey: 'googleTokenCache',
    });
    const manager = new GoogleCredentialsManager(config);
    const {context, state} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(configuredCreds);
    expect(configuredCreds.refresh).toHaveBeenCalledOnce();
    expect(state.get('googleTokenCache')).toBeUndefined();
  });

  it('starts OAuth flow when refresh throws GoogleOAuthRefreshError', async () => {
    const failingCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'expiredRefreshToken',
      refresh: vi.fn(async () => {
        throw new GoogleOAuthRefreshError('invalid_grant', {status: 400});
      }),
    };
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: failingCreds}),
    );
    const {context, requestCredential} = createMockToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledOnce();
  });

  it('propagates unexpected non-GoogleOAuthRefreshError errors from OAuth token refresh', async () => {
    const failingCreds: GoogleOAuthCredentials = {
      valid: false,
      expired: true,
      refreshToken: 'refreshToken1',
      refresh: vi.fn(async () => {
        throw new Error('token endpoint unreachable');
      }),
    };
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: failingCreds}),
    );
    const {context, requestCredential} = createMockToolContext();

    await expect(manager.getValidCredentials(context)).rejects.toThrow(
      'token endpoint unreachable',
    );
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('requests OAuth credentials when none exist and persists completed flow across manager instances', async () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'testClientId',
      clientSecret: 'testClientSecret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
      tokenCacheKey: 'googleTokenCache',
    });
    const manager1 = new GoogleCredentialsManager(config);
    const {context, getAuthResponse, requestCredential, state} =
      createMockToolContext();

    expect(await manager1.getValidCredentials(context)).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledOnce();
    const authConfig = requestCredential.mock.calls[0]?.[0] as AuthConfig;
    expect(authConfig.authScheme.type).toBe('oauth2');
    expect(authConfig.credentialKey).toBe('googleTokenCache');

    getAuthResponse.mockReturnValue({
      oauth2: {
        accessToken: 'cachedAccessToken',
        refreshToken: 'cachedRefreshToken',
        expiresAt: Date.now() + 3_600_000,
      },
    });

    const result1 = (await manager1.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;
    expect(result1?.token).toBe('cachedAccessToken');
    expect(state.get<string>('googleTokenCache')).toBeDefined();

    const manager2 = new GoogleCredentialsManager(config);
    getAuthResponse.mockReturnValue(undefined);
    const result2 = (await manager2.getValidCredentials(context)) as
      GoogleOAuthCredentials | undefined;

    expect(result2?.token).toBe('cachedAccessToken');
    expect(result2?.refreshToken).toBe('cachedRefreshToken');
  });

  it('accepts google-auth-library JWT, OAuth2Client, and GoogleAuth clients without casts', async () => {
    const jwtClient = new JWT({
      email: 'service-account@example.iam.gserviceaccount.com',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const oauth2Client = new OAuth2Client({
      clientId: 'clientId',
      clientSecret: 'clientSecret',
    });
    const googleAuth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const jwtCreds: GoogleCredentials = jwtClient;
    const oauthCreds: GoogleCredentials = oauth2Client;
    const authCreds: GoogleCredentials = googleAuth;
    expect(isGoogleAuthClient(jwtCreds)).toBe(true);
    expect(isGoogleAuthClient(oauthCreds)).toBe(true);
    expect(isGoogleAuthClient(authCreds)).toBe(true);
    expect(isGoogleAuthClient({token: 'tok'})).toBe(false);

    const mockClient: GoogleAuthClient = {
      getRequestHeaders: async () => ({Authorization: 'Bearer mock'}),
    };
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: mockClient}),
    );
    const {context, requestCredential} = createMockToolContext();

    expect(await manager.getValidCredentials(context)).toBe(mockClient);
    expect(requestCredential).not.toHaveBeenCalled();

    const jwtManager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials: jwtClient}),
    );
    expect(await jwtManager.getValidCredentials(context)).toBe(jwtClient);
  });
});
