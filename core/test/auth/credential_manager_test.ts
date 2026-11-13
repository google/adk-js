/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  BaseCredentialExchanger,
  BaseCredentialRefresher,
  BaseCredentialService,
  Context,
  CredentialExchangeError,
  CredentialManager,
  ExchangeResult,
  InMemoryCredentialService,
  InvocationContext,
  createSession,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const AUTHORIZATION_CODE_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: {read: 'Read access', write: 'Write access'},
    },
  },
};

const CLIENT_CREDENTIALS_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    clientCredentials: {
      tokenUrl: 'https://auth.example.com/token',
      scopes: {},
    },
  },
};

const OPEN_ID_CONNECT_SCHEME: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://auth.example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  grantTypesSupported: ['authorization_code'],
  scopes: ['openid', 'profile'],
};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const HTTP_BEARER_SCHEME: AuthScheme = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
};

function createOAuth2Credential(
  overrides: NonNullable<AuthCredential['oauth2']> = {},
): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'client-id-1',
      clientSecret: 'client-secret-1',
      redirectUri: 'https://app.example.com/callback',
      ...overrides,
    },
  };
}

function createServiceAccountCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: {
      serviceAccountCredential: {
        type: 'service_account',
        projectId: 'example-project',
        privateKeyId: 'key-id-1',
        privateKey: 'placeholder-private-key',
        clientEmail: 'service@example.com',
        clientId: '123456789',
        authUri: 'https://accounts.google.com/o/oauth2/auth',
        tokenUri: 'https://oauth2.googleapis.com/token',
        authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
        clientX509CertUrl:
          'https://www.googleapis.com/robot/v1/metadata/x509/service%40example.com',
        universeDomain: 'googleapis.com',
      },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  };
}

function createToolContext(
  options: {
    appName?: string;
    userId?: string;
    sessionId?: string;
    functionCallId?: string;
    state?: Record<string, unknown>;
    credentialService?: BaseCredentialService;
  } = {},
): Context {
  const session = createSession({
    id: options.sessionId ?? 'session-1',
    appName: options.appName ?? 'test-app',
    userId: options.userId ?? 'user-1',
    state: options.state ?? {},
  });
  return new Context({
    invocationContext: {
      session,
      credentialService: options.credentialService,
    } as unknown as InvocationContext,
    functionCallId: options.functionCallId ?? 'call-1',
  });
}

class FakeExchanger implements BaseCredentialExchanger {
  readonly calls: Array<{
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }> = [];

  constructor(
    private readonly handler: (params: {
      authCredential: AuthCredential;
      authScheme?: AuthScheme;
    }) => Promise<ExchangeResult>,
  ) {}

  exchange(params: {
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }): Promise<ExchangeResult> {
    this.calls.push(params);
    return this.handler(params);
  }
}

class FakeRefresher implements BaseCredentialRefresher {
  readonly neededCalls: Array<{
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }> = [];
  readonly refreshCalls: Array<{
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }> = [];

  constructor(
    private readonly needed: boolean,
    private readonly refreshedCredential: AuthCredential,
  ) {}

  async isRefreshNeeded(
    authCredential: AuthCredential,
    authScheme?: AuthScheme,
  ): Promise<boolean> {
    this.neededCalls.push({authCredential, authScheme});
    return this.needed;
  }

  async refresh(
    authCredential: AuthCredential,
    authScheme?: AuthScheme,
  ): Promise<AuthCredential> {
    this.refreshCalls.push({authCredential, authScheme});
    return this.refreshedCredential;
  }
}

describe('CredentialManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('initializes with an AuthConfig', async () => {
    const apiKeyCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key-1',
    };
    const authConfig: AuthConfig = {
      credentialKey: 'api_key_cred',
      authScheme: API_KEY_SCHEME,
      rawAuthCredential: apiKeyCredential,
    };

    const manager = new CredentialManager(authConfig);

    expect(await manager.getAuthCredential(createToolContext())).toEqual(
      apiKeyCredential,
    );
  });

  it('delegates requestCredential to the tool context', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const context = createToolContext({functionCallId: 'fc-auth-1'});
    const requestSpy = vi.spyOn(context, 'requestCredential');

    const manager = new CredentialManager(authConfig);
    await manager.requestCredential(context);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(authConfig);
    expect(
      context.eventActions.requestedAuthConfigs['fc-auth-1']
        ?.exchangedAuthCredential?.oauth2?.authUri,
    ).toContain('https://auth.example.com/authorize');
  });

  it('loads a credential from the auth response and saves it to the credential service', async () => {
    const responseCredential = createOAuth2Credential({
      accessToken: 'token-from-response',
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const credentialService = new InMemoryCredentialService();
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');
    const context = createToolContext({
      credentialService,
      state: {'temp:oauth2_cred': responseCredential},
    });

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(responseCredential);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(await credentialService.loadCredential(authConfig, context)).toEqual(
      responseCredential,
    );
  });

  it('returns undefined without exchanging, refreshing, or saving when no credential is available', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const credentialService = new InMemoryCredentialService();
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');
    const context = createToolContext({credentialService});
    const exchanger = new FakeExchanger(async ({authCredential}) => ({
      credential: authCredential,
      wasExchanged: true,
    }));
    const refresher = new FakeRefresher(true, createOAuth2Credential());

    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);
    manager.registerCredentialRefresher(AuthCredentialTypes.OAUTH2, refresher);

    const result = await manager.getAuthCredential(context);

    expect(result).toBeUndefined();
    expect(exchanger.calls).toHaveLength(0);
    expect(refresher.neededCalls).toHaveLength(0);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('ignores a pre-populated exchangedAuthCredential when no credential service entry exists', async () => {
    const exchanged = createOAuth2Credential({
      accessToken: 'cached-access-token',
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
      exchangedAuthCredential: exchanged,
    };
    const context = createToolContext();

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toBeUndefined();
  });

  it('prefers the credential loaded from the credential service over exchangedAuthCredential', async () => {
    const fromService = createOAuth2Credential({
      accessToken: 'service-access-token',
    });
    const fromConfig = createOAuth2Credential({
      accessToken: 'config-access-token',
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
      exchangedAuthCredential: fromConfig,
    };
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    await credentialService.saveCredential(
      {...authConfig, exchangedAuthCredential: fromService},
      context,
    );

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(fromService);
  });

  it('passes authConfig and toolContext to credentialService.loadCredential', async () => {
    const storedCredential = createOAuth2Credential({
      accessToken: 'stored-access-token',
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const credentialService: BaseCredentialService = {
      loadCredential: vi.fn().mockResolvedValue(storedCredential),
      saveCredential: vi.fn().mockResolvedValue(undefined),
    };
    const context = createToolContext({credentialService});

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(credentialService.loadCredential).toHaveBeenCalledTimes(1);
    expect(credentialService.loadCredential).toHaveBeenCalledWith(
      authConfig,
      context,
    );
    expect(result).toEqual(storedCredential);
  });

  it('returns undefined when no credential service is configured and no auth response exists', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const context = createToolContext();

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toBeUndefined();
  });

  it('saves an updated credential to the credential service without mutating authConfig', async () => {
    const responseCredential = createOAuth2Credential({
      accessToken: 'response-token',
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const credentialService: BaseCredentialService = {
      loadCredential: vi.fn().mockResolvedValue(undefined),
      saveCredential: vi.fn().mockResolvedValue(undefined),
    };
    const context = createToolContext({
      credentialService,
      state: {'temp:oauth2_cred': responseCredential},
    });

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(responseCredential);
    expect(credentialService.saveCredential).toHaveBeenCalledTimes(1);
    expect(credentialService.saveCredential).toHaveBeenCalledWith(
      {
        ...authConfig,
        exchangedAuthCredential: responseCredential,
      },
      context,
    );
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('succeeds without mutating authConfig when saving with no credential service configured', async () => {
    const responseCredential = createOAuth2Credential({
      accessToken: 'response-token',
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const context = createToolContext({
      state: {'temp:oauth2_cred': responseCredential},
    });

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(responseCredential);
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('refreshes an expired OAuth2 credential using the registered refresher and saves it', async () => {
    const expiredCredential = createOAuth2Credential({
      accessToken: 'expired-token',
      refreshToken: 'refresh-token-1',
      expiresAt: 1000,
    });
    const refreshedCredential = createOAuth2Credential({
      accessToken: 'refreshed-token',
      refreshToken: 'refresh-token-2',
      expiresAt: Date.now() + 3_600_000,
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    await credentialService.saveCredential(
      {...authConfig, exchangedAuthCredential: expiredCredential},
      context,
    );

    const refresher = new FakeRefresher(true, refreshedCredential);
    const manager = new CredentialManager(authConfig);
    manager.registerCredentialRefresher(AuthCredentialTypes.OAUTH2, refresher);

    const result = await manager.getAuthCredential(context);

    expect(refresher.neededCalls).toEqual([
      {
        authCredential: expiredCredential,
        authScheme: AUTHORIZATION_CODE_SCHEME,
      },
    ]);
    expect(refresher.refreshCalls).toEqual([
      {
        authCredential: expiredCredential,
        authScheme: AUTHORIZATION_CODE_SCHEME,
      },
    ]);
    expect(result).toEqual(refreshedCredential);
    expect(await credentialService.loadCredential(authConfig, context)).toEqual(
      refreshedCredential,
    );
  });

  it('returns an unexchanged credential unchanged when no refresher is registered for its type', async () => {
    const storedCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token: 'stored-bearer-token'},
      },
    };
    const authConfig: AuthConfig = {
      credentialKey: 'http_cred',
      authScheme: HTTP_BEARER_SCHEME,
    };
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    await credentialService.saveCredential(
      {...authConfig, exchangedAuthCredential: storedCredential},
      context,
    );
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(storedCredential);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('returns undefined for a service account credential when the scheme is not a client-credentials flow', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'sa_cred',
      authScheme: HTTP_BEARER_SCHEME,
      rawAuthCredential: createServiceAccountCredential(),
    };
    const exchanger = new FakeExchanger(async ({authCredential}) => ({
      credential: authCredential,
      wasExchanged: true,
    }));

    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      exchanger,
    );
    const result = await manager.getAuthCredential(createToolContext());

    expect(result).toBeUndefined();
    expect(exchanger.calls).toHaveLength(0);
  });

  it('reads the auth response for a service account raw credential', async () => {
    const bearerFromResponse: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token: 'response-bearer-token'},
      },
    };
    const authConfig: AuthConfig = {
      credentialKey: 'sa_cred',
      authScheme: HTTP_BEARER_SCHEME,
      rawAuthCredential: createServiceAccountCredential(),
    };
    const credentialService = new InMemoryCredentialService();
    const loadSpy = vi.spyOn(credentialService, 'loadCredential');
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');
    const context = createToolContext({
      credentialService,
      state: {'temp:sa_cred': bearerFromResponse},
    });

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(bearerFromResponse);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('propagates an exchanger error that is not a CredentialExchangeError', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'sa_cred',
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential: createServiceAccountCredential(),
    };
    const exchanger = new FakeExchanger(async () => {
      throw new Error('signing failed');
    });

    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      exchanger,
    );

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow('signing failed');
  });

  it('returns a deep copy of an API key raw credential immediately without exchange or refresh', async () => {
    const rawCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'api-key-value',
    };
    const authConfig: AuthConfig = {
      credentialKey: 'api_key_cred',
      authScheme: API_KEY_SCHEME,
      rawAuthCredential: rawCredential,
    };
    const credentialService = new InMemoryCredentialService();
    const loadSpy = vi.spyOn(credentialService, 'loadCredential');
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');
    const context = createToolContext({credentialService});

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(rawCredential);
    expect(result).not.toBe(rawCredential);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('returns a deep copy of an HTTP raw credential immediately without exchange or refresh', async () => {
    const rawCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token: 'http-bearer-token'},
      },
    };
    const authConfig: AuthConfig = {
      credentialKey: 'http_cred',
      authScheme: HTTP_BEARER_SCHEME,
      rawAuthCredential: rawCredential,
    };
    const context = createToolContext();

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(rawCredential);
    expect(result).not.toBe(rawCredential);
    if (result?.http) {
      result.http.credentials.token = 'mutated';
    }
    expect(rawCredential.http?.credentials.token).toBe('http-bearer-token');
  });

  it('processes OAuth2 credentials through the load and exchange pipeline rather than returning rawAuthCredential', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const context = createToolContext();

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toBeUndefined();
  });

  it('throws when rawAuthCredential is missing for an oauth2 authScheme', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
    };
    const manager = new CredentialManager(authConfig);

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'rawAuthCredential is required for authScheme type oauth2',
    );
  });

  it('throws when rawAuthCredential is missing for an openIdConnect authScheme', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'oidc_cred',
      authScheme: OPEN_ID_CONNECT_SCHEME,
    };
    const manager = new CredentialManager(authConfig);

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'rawAuthCredential is required for authScheme type openIdConnect',
    );
  });

  it('does not throw when rawAuthCredential is missing for a non-OAuth scheme', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'api_key_cred',
      authScheme: API_KEY_SCHEME,
    };
    const manager = new CredentialManager(authConfig);

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).resolves.toBeUndefined();
  });

  it('throws when rawAuthCredential has authType OAUTH2 or OPEN_ID_CONNECT but no oauth2 payload', async () => {
    const oauth2Config: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
      },
    };
    const oidcConfig: AuthConfig = {
      credentialKey: 'oidc_cred',
      authScheme: OPEN_ID_CONNECT_SCHEME,
      rawAuthCredential: {
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      },
    };

    await expect(
      new CredentialManager(oauth2Config).getAuthCredential(
        createToolContext(),
      ),
    ).rejects.toThrow(
      'authConfig.rawAuthCredential.oauth2 is required for credential type oauth2',
    );
    await expect(
      new CredentialManager(oidcConfig).getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'authConfig.rawAuthCredential.oauth2 is required for credential type openIdConnect',
    );
  });

  it('returns the service account credential unchanged when no service account exchanger is registered', async () => {
    const serviceAccountCredential = createServiceAccountCredential();
    const authConfig: AuthConfig = {
      credentialKey: 'sa_cred',
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential: serviceAccountCredential,
    };
    const manager = new CredentialManager(authConfig);

    const result = await manager.getAuthCredential(createToolContext());

    expect(result).toEqual(serviceAccountCredential);
    expect(result).not.toBe(serviceAccountCredential);
  });

  it('exchanges a service account credential via a registered exchanger and skips credentialService load and save', async () => {
    const serviceAccountCredential = createServiceAccountCredential();
    const exchangedBearer: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token: 'sa-access-token'},
      },
    };
    const authConfig: AuthConfig = {
      credentialKey: 'sa_cred',
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential: serviceAccountCredential,
    };
    const credentialService = new InMemoryCredentialService();
    const loadSpy = vi.spyOn(credentialService, 'loadCredential');
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');
    const context = createToolContext({credentialService});
    const exchanger = new FakeExchanger(async () => ({
      credential: exchangedBearer,
      wasExchanged: true,
    }));

    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      exchanger,
    );

    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(exchangedBearer);
    expect(exchanger.calls).toHaveLength(1);
    expect(exchanger.calls[0].authCredential).toEqual(serviceAccountCredential);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('returns an auth response credential unchanged when no exchanger is registered for its type', async () => {
    const apiKeyFromResponse: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'user-supplied-api-key',
    };
    const authConfig: AuthConfig = {
      credentialKey: 'api_key_cred',
      authScheme: API_KEY_SCHEME,
    };
    const context = createToolContext({
      state: {'temp:api_key_cred': apiKeyFromResponse},
    });

    const manager = new CredentialManager(authConfig);
    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(apiKeyFromResponse);
  });

  it('skips refreshing when the credential was just exchanged in the same turn', async () => {
    const authResponse = createOAuth2Credential({
      authCode: 'auth-code-1',
    });
    const exchanged = createOAuth2Credential({
      accessToken: 'freshly-exchanged-token',
      expiresAt: 1,
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const context = createToolContext({
      state: {'temp:oauth2_cred': authResponse},
    });
    const exchanger = new FakeExchanger(async () => ({
      credential: exchanged,
      wasExchanged: true,
    }));
    const refresher = new FakeRefresher(
      true,
      createOAuth2Credential({accessToken: 'should-not-run'}),
    );

    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);
    manager.registerCredentialRefresher(AuthCredentialTypes.OAUTH2, refresher);

    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(exchanged);
    expect(exchanger.calls).toHaveLength(1);
    expect(refresher.neededCalls).toHaveLength(0);
    expect(refresher.refreshCalls).toHaveLength(0);
  });

  it('discards an unredeemed authorization code when token exchange fails and does not save it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
      } as Response),
    );

    for (const [authScheme, authType, unexchanged] of [
      [
        AUTHORIZATION_CODE_SCHEME,
        AuthCredentialTypes.OAUTH2,
        createOAuth2Credential({authCode: 'spent-code'}),
      ],
      [
        AUTHORIZATION_CODE_SCHEME,
        AuthCredentialTypes.OAUTH2,
        createOAuth2Credential({
          authResponseUri: 'https://app.example.com/callback?code=spent',
        }),
      ],
      [
        OPEN_ID_CONNECT_SCHEME,
        AuthCredentialTypes.OPEN_ID_CONNECT,
        {
          authType: AuthCredentialTypes.OPEN_ID_CONNECT,
          oauth2: {
            clientId: 'client-id-1',
            clientSecret: 'client-secret-1',
            authCode: 'spent-oidc-code',
          },
        } satisfies AuthCredential,
      ],
    ] as const) {
      const authConfig: AuthConfig = {
        credentialKey: 'code_cred',
        authScheme,
        rawAuthCredential: {
          authType,
          oauth2: {
            clientId: 'client-id-1',
            clientSecret: 'client-secret-1',
          },
        },
      };
      const credentialService = new InMemoryCredentialService();
      const saveSpy = vi.spyOn(credentialService, 'saveCredential');
      const context = createToolContext({
        credentialService,
        state: {'temp:code_cred': unexchanged},
      });

      const manager = new CredentialManager(authConfig);
      const result = await manager.getAuthCredential(context);

      expect(result).toBeUndefined();
      expect(saveSpy).not.toHaveBeenCalled();
    }
  });

  it('ignores a stored unredeemed authorization code and exchanges a fresh auth response', async () => {
    const storedSpent = createOAuth2Credential({
      authCode: 'spent-code',
    });
    const freshAuthResponse = createOAuth2Credential({
      authCode: 'fresh-code',
    });
    const redeemed = createOAuth2Credential({
      authCode: 'fresh-code',
      accessToken: 'redeemed-access-token',
    });
    const authConfig: AuthConfig = {
      credentialKey: 'oauth2_cred',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({
      credentialService,
      state: {'temp:oauth2_cred': freshAuthResponse},
    });
    await credentialService.saveCredential(
      {...authConfig, exchangedAuthCredential: storedSpent},
      context,
    );

    const exchanger = new FakeExchanger(async ({authCredential}) => ({
      credential:
        authCredential.oauth2?.authCode === 'fresh-code'
          ? redeemed
          : authCredential,
      wasExchanged: authCredential.oauth2?.authCode === 'fresh-code',
    }));

    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);

    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(redeemed);
    expect(await credentialService.loadCredential(authConfig, context)).toEqual(
      redeemed,
    );
  });

  it('re-exchanges raw client credentials when a stored client-credentials token expires without a refresh token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-cc-token',
          expires_in: 3600,
        }),
      } as Response),
    );

    const oidcClientCredentialsScheme: AuthScheme = {
      ...OPEN_ID_CONNECT_SCHEME,
      grantTypesSupported: ['client_credentials'],
    };

    for (const [authScheme, authType] of [
      [CLIENT_CREDENTIALS_SCHEME, AuthCredentialTypes.OAUTH2],
      [oidcClientCredentialsScheme, AuthCredentialTypes.OPEN_ID_CONNECT],
    ] as const) {
      const rawAuthCredential: AuthCredential = {
        authType,
        oauth2: {
          clientId: 'cc-client-id',
          clientSecret: 'cc-client-secret',
        },
      };
      const expiredStored: AuthCredential = {
        authType,
        oauth2: {
          clientId: 'cc-client-id',
          clientSecret: 'cc-client-secret',
          accessToken: 'expired-cc-token',
          expiresAt: Date.now() - 120_000,
        },
      };
      const authConfig: AuthConfig = {
        credentialKey: 'cc_cred',
        authScheme,
        rawAuthCredential,
      };
      const credentialService = new InMemoryCredentialService();
      const context = createToolContext({credentialService});
      await credentialService.saveCredential(
        {...authConfig, exchangedAuthCredential: expiredStored},
        context,
      );

      const manager = new CredentialManager(authConfig);
      const result = await manager.getAuthCredential(context);

      expect(result?.oauth2?.accessToken).toBe('new-cc-token');
      expect(rawAuthCredential.oauth2?.accessToken).toBeUndefined();
      expect(
        (await credentialService.loadCredential(authConfig, context))?.oauth2
          ?.accessToken,
      ).toBe('new-cc-token');
    }
  });

  it('uses the refresher for an expired client-credentials token when a refreshToken is present', async () => {
    const rawAuthCredential = createOAuth2Credential();
    const expiredWithRefreshToken = createOAuth2Credential({
      accessToken: 'expired-token',
      refreshToken: 'cc-refresh-token',
      expiresAt: Date.now() - 120_000,
    });
    const refreshed = createOAuth2Credential({
      accessToken: 'refreshed-via-refresh-token',
      refreshToken: 'cc-refresh-token',
      expiresAt: Date.now() + 3_600_000,
    });
    const authConfig: AuthConfig = {
      credentialKey: 'cc_cred',
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential,
    };
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    await credentialService.saveCredential(
      {...authConfig, exchangedAuthCredential: expiredWithRefreshToken},
      context,
    );

    const exchanger = new FakeExchanger(async ({authCredential}) => ({
      credential: authCredential,
      wasExchanged: false,
    }));
    const refresher = new FakeRefresher(true, refreshed);

    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);
    manager.registerCredentialRefresher(AuthCredentialTypes.OAUTH2, refresher);

    const result = await manager.getAuthCredential(context);

    expect(result).toEqual(refreshed);
    expect(exchanger.calls).toHaveLength(1);
    expect(refresher.refreshCalls).toHaveLength(1);
  });

  it('returns the stored expired client-credentials token unsaved when re-exchange fails', async () => {
    const rawAuthCredential = createOAuth2Credential();
    const expiredStored = createOAuth2Credential({
      accessToken: 'expired-cc-token',
      expiresAt: Date.now() - 120_000,
    });
    const authConfig: AuthConfig = {
      credentialKey: 'cc_cred',
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential,
    };
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    await credentialService.saveCredential(
      {...authConfig, exchangedAuthCredential: expiredStored},
      context,
    );
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');

    const failingExchanger = new FakeExchanger(async ({authCredential}) => {
      if (authCredential.oauth2?.accessToken) {
        return {credential: authCredential, wasExchanged: false};
      }
      throw new CredentialExchangeError('token endpoint unavailable');
    });

    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(
      AuthCredentialTypes.OAUTH2,
      failingExchanger,
    );

    const result = await manager.getAuthCredential(context);

    expect(result).toBe(expiredStored);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(rawAuthCredential.oauth2?.accessToken).toBeUndefined();
  });

  it('does not leak user credentials across users sharing the same AuthConfig and CredentialManager', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'shared_oauth2_key',
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: createOAuth2Credential(),
    };
    const credentialService = new InMemoryCredentialService();
    const manager = new CredentialManager(authConfig);

    const userACredential = createOAuth2Credential({
      authUri: 'https://auth.example.com/authorize?state=user-a',
      state: 'user-a',
      accessToken: 'token-user-a',
      expiresAt: Date.now() + 3_600_000,
    });
    const contextA = createToolContext({
      userId: 'user-a',
      sessionId: 'session-a',
      functionCallId: 'call-a',
      credentialService,
      state: {'temp:shared_oauth2_key': userACredential},
    });
    const contextB = createToolContext({
      userId: 'user-b',
      sessionId: 'session-b',
      functionCallId: 'call-b',
      credentialService,
    });

    const loadedA = await manager.getAuthCredential(contextA);
    const loadedB = await manager.getAuthCredential(contextB);
    await manager.requestCredential(contextB);

    expect(loadedA?.oauth2?.accessToken).toBe('token-user-a');
    expect(loadedB).toBeUndefined();
    expect(
      contextB.eventActions.requestedAuthConfigs['call-b']
        ?.exchangedAuthCredential?.oauth2?.accessToken,
    ).toBeUndefined();
  });
});

/**
 * Tracks how many exchanges run at once and lets each one wait until a target
 * number are in flight, or until a short timeout when they are serialized.
 */
class ConcurrencyProbe {
  active = 0;
  maxActive = 0;
  private readonly target: number;
  private releaseAll!: () => void;
  private readonly allStarted: Promise<void>;

  constructor(target: number) {
    this.target = target;
    this.allStarted = new Promise<void>((resolve) => {
      this.releaseAll = resolve;
    });
  }

  async run<T>(fn: () => T): Promise<T> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.active >= this.target) {
      this.releaseAll();
    }
    await Promise.race([
      this.allStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);
    this.active--;
    return fn();
  }
}

function createClientCredentialsExchanger(
  probe: ConcurrencyProbe,
  tokenFor: () => string,
): {exchanger: FakeExchanger; exchangeCount: () => number} {
  let count = 0;
  const exchanger = new FakeExchanger(async ({authCredential}) => {
    if (authCredential.oauth2?.accessToken) {
      return {credential: authCredential, wasExchanged: false};
    }
    count++;
    return probe.run(() => ({
      credential: createOAuth2Credential({
        accessToken: tokenFor(),
        expiresAt: Date.now() + 3_600_000,
      }),
      wasExchanged: true,
    }));
  });
  return {exchanger, exchangeCount: () => count};
}

function createClientCredentialsManager(
  credentialKey: string,
  exchanger: FakeExchanger,
): CredentialManager {
  const manager = new CredentialManager({
    credentialKey,
    authScheme: CLIENT_CREDENTIALS_SCHEME,
    rawAuthCredential: createOAuth2Credential(),
  });
  manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);
  manager.registerCredentialRefresher(
    AuthCredentialTypes.OAUTH2,
    new FakeRefresher(false, createOAuth2Credential()),
  );
  return manager;
}

describe('CredentialManager concurrency', () => {
  it('exchanges once when parallel calls share an app, user, and credential key', async () => {
    const probe = new ConcurrencyProbe(2);
    const {exchanger, exchangeCount} = createClientCredentialsExchanger(
      probe,
      () => 'shared-token',
    );
    const context = createToolContext({
      credentialService: new InMemoryCredentialService(),
    });
    const managers = [
      createClientCredentialsManager('shared-key', exchanger),
      createClientCredentialsManager('shared-key', exchanger),
    ];

    const results = await Promise.all(
      managers.map((manager) => manager.getAuthCredential(context)),
    );

    expect(results.map((r) => r?.oauth2?.accessToken)).toEqual([
      'shared-token',
      'shared-token',
    ]);
    expect(exchangeCount()).toBe(1);
    expect(probe.maxActive).toBe(1);
  });

  it('runs parallel calls one at a time without a credential service', async () => {
    const probe = new ConcurrencyProbe(2);
    const {exchanger, exchangeCount} = createClientCredentialsExchanger(
      probe,
      () => 'exchanged-token',
    );
    const context = createToolContext();
    const managers = [
      createClientCredentialsManager('shared-key', exchanger),
      createClientCredentialsManager('shared-key', exchanger),
    ];

    const results = await Promise.all(
      managers.map((manager) => manager.getAuthCredential(context)),
    );

    expect(results.map((r) => r?.oauth2?.accessToken)).toEqual([
      'exchanged-token',
      'exchanged-token',
    ]);
    expect(exchangeCount()).toBe(2);
    expect(probe.maxActive).toBe(1);
  });

  it('does not make calls for different credential keys wait for each other', async () => {
    const probe = new ConcurrencyProbe(2);
    const {exchanger} = createClientCredentialsExchanger(probe, () => 'token');
    const context = createToolContext({
      credentialService: new InMemoryCredentialService(),
    });

    await Promise.all([
      createClientCredentialsManager('key-a', exchanger).getAuthCredential(
        context,
      ),
      createClientCredentialsManager('key-b', exchanger).getAuthCredential(
        context,
      ),
    ]);

    expect(probe.maxActive).toBe(2);
  });

  it('does not make calls for different users with the same key wait for each other', async () => {
    const probe = new ConcurrencyProbe(2);
    const tokens = ['token-a', 'token-b'];
    const {exchanger} = createClientCredentialsExchanger(
      probe,
      () => tokens.shift() ?? 'extra-token',
    );
    const credentialService = new InMemoryCredentialService();
    const contextA = createToolContext({userId: 'user-a', credentialService});
    const contextB = createToolContext({userId: 'user-b', credentialService});

    const results = await Promise.all([
      createClientCredentialsManager('shared-key', exchanger).getAuthCredential(
        contextA,
      ),
      createClientCredentialsManager('shared-key', exchanger).getAuthCredential(
        contextB,
      ),
    ]);

    expect(probe.maxActive).toBe(2);
    expect(results.map((r) => r?.oauth2?.accessToken)).toEqual([
      'token-a',
      'token-b',
    ]);
  });

  it('lets a queued call run after an earlier call for the same key rejects', async () => {
    const probe = new ConcurrencyProbe(1);
    const {exchanger} = createClientCredentialsExchanger(
      probe,
      () => 'after-failure-token',
    );
    const context = createToolContext();
    const invalidManager = new CredentialManager({
      credentialKey: 'shared-key',
      authScheme: CLIENT_CREDENTIALS_SCHEME,
    });

    const [failed, succeeded] = await Promise.allSettled([
      invalidManager.getAuthCredential(context),
      createClientCredentialsManager('shared-key', exchanger).getAuthCredential(
        context,
      ),
    ]);

    expect(failed.status).toBe('rejected');
    expect(succeeded.status).toBe('fulfilled');
    if (succeeded.status === 'fulfilled') {
      expect(succeeded.value?.oauth2?.accessToken).toBe('after-failure-token');
    }
  });
});
