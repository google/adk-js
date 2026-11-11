/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * tests/unittests/tools/openapi_tool/auth/credential_exchangers/test_auto_auth_credential_exchanger.py
 * at tag v0.1.0.
 *
 * Test names are kept verbatim from the Python originals so a reviewer can
 * grep for them.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  AutoAuthCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
  OAuth2CredentialExchanger,
  ServiceAccountCredentialExchanger,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const authScheme: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const exchangedCredential: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
};

function credentialOf(authType: AuthCredentialTypes): AuthCredential {
  return {authType};
}

/**
 * A mock exchanger, typed as the parameter the class accepts so that the call
 * assertions are checked rather than widened.
 */
function createMockExchanger(credential: AuthCredential) {
  return {
    exchange: vi.fn(
      async (_params: {
        authScheme?: AuthScheme;
        authCredential: AuthCredential;
      }): Promise<ExchangeResult> => ({credential, wasExchanged: true}),
    ),
  };
}

function spyOnDefaultOAuth2Exchanger() {
  return vi
    .spyOn(OAuth2CredentialExchanger.prototype, 'exchange')
    .mockResolvedValue({credential: exchangedCredential, wasExchanged: true});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AutoAuthCredentialExchanger ported from adk-python v0.1.0', () => {
  it('test_init_with_custom_exchangers', async () => {
    const customExchanger = createMockExchanger(exchangedCredential);
    const oauth2Spy = spyOnDefaultOAuth2Exchanger();
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.API_KEY]: customExchanger,
    });

    const apiKeyResult = await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.API_KEY),
    });
    const openIdResult = await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OPEN_ID_CONNECT),
    });

    // The custom exchanger is registered for API_KEY.
    expect(customExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(apiKeyResult.credential).toBe(exchangedCredential);
    // The OPEN_ID_CONNECT default survives the merge.
    expect(oauth2Spy).toHaveBeenCalledTimes(1);
    expect(openIdResult.credential).toBe(exchangedCredential);
  });

  it('test_exchange_credential_no_auth_credential', async () => {
    const oauth2Spy = spyOnDefaultOAuth2Exchanger();
    const autoExchanger = new AutoAuthCredentialExchanger();

    const result = await autoExchanger.exchange({
      authScheme,
      authCredential: undefined,
    });

    expect(result).toBeNull();
    expect(oauth2Spy).not.toHaveBeenCalled();
  });

  it('test_exchange_credential_no_exchange', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();
    const authCredential = credentialOf(AuthCredentialTypes.API_KEY);

    const result = await autoExchanger.exchange({authScheme, authCredential});

    // adk-python returns the bare credential; adk-js wraps it and reports that
    // no exchange happened, so the caller can still tell the two apart.
    expect(result).toEqual({credential: authCredential, wasExchanged: false});
  });

  it('test_exchange_credential_open_id_connect', async () => {
    const mockExchanger = createMockExchanger(exchangedCredential);
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.OPEN_ID_CONNECT]: mockExchanger,
    });
    const authCredential = credentialOf(AuthCredentialTypes.OPEN_ID_CONNECT);

    const result = await autoExchanger.exchange({authScheme, authCredential});

    expect(result).toEqual({
      credential: exchangedCredential,
      wasExchanged: true,
    });
    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(mockExchanger.exchange).toHaveBeenCalledWith({
      authScheme,
      authCredential,
    });
  });

  it('test_exchange_credential_service_account', async () => {
    const mockExchanger = createMockExchanger(exchangedCredential);
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.SERVICE_ACCOUNT]: mockExchanger,
    });
    const authCredential = credentialOf(AuthCredentialTypes.SERVICE_ACCOUNT);

    const result = await autoExchanger.exchange({authScheme, authCredential});

    expect(result).toEqual({
      credential: exchangedCredential,
      wasExchanged: true,
    });
    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(mockExchanger.exchange).toHaveBeenCalledWith({
      authScheme,
      authCredential,
    });
  });

  it('test_exchange_credential_custom_exchanger', async () => {
    const mockExchanger = createMockExchanger(exchangedCredential);
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.API_KEY]: mockExchanger,
    });
    const authCredential = credentialOf(AuthCredentialTypes.API_KEY);

    const result = await autoExchanger.exchange({authScheme, authCredential});

    expect(result).toEqual({
      credential: exchangedCredential,
      wasExchanged: true,
    });
    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(mockExchanger.exchange).toHaveBeenCalledWith({
      authScheme,
      authCredential,
    });
  });
});

describe('AutoAuthCredentialExchanger adk-js specific behaviour', () => {
  it('keeps the default when a custom entry is undefined', async () => {
    const oauth2Spy = spyOnDefaultOAuth2Exchanger();
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.OPEN_ID_CONNECT]: undefined,
    });

    const result = await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OPEN_ID_CONNECT),
    });

    expect(oauth2Spy).toHaveBeenCalledTimes(1);
    expect(result.credential).toBe(exchangedCredential);
  });

  it('overrides one type without disturbing the other defaults', async () => {
    const mockExchanger = createMockExchanger(exchangedCredential);
    const oauth2Spy = spyOnDefaultOAuth2Exchanger();
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.SERVICE_ACCOUNT]: mockExchanger,
    });

    await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.SERVICE_ACCOUNT),
    });
    await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OAUTH2),
    });
    await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OPEN_ID_CONNECT),
    });

    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(oauth2Spy).toHaveBeenCalledTimes(2);
  });

  it('resolves to null when the call omits authCredential', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();

    await expect(autoExchanger.exchange({})).resolves.toBeNull();
  });

  it('propagates an error from the delegated exchanger unwrapped', async () => {
    const failure = new CredentialExchangeError('token endpoint refused');
    const failingExchanger = {
      exchange: vi.fn(
        async (_params: {
          authScheme?: AuthScheme;
          authCredential: AuthCredential;
        }): Promise<ExchangeResult> => {
          throw failure;
        },
      ),
    };
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.OAUTH2]: failingExchanger,
    });

    await expect(
      autoExchanger.exchange({
        authScheme,
        authCredential: credentialOf(AuthCredentialTypes.OAUTH2),
      }),
    ).rejects.toBe(failure);
  });
});

describe('AutoAuthCredentialExchanger default OAuth2 and OpenID Connect exchange', () => {
  const oauth2Scheme: AuthScheme = {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
        scopes: {},
      },
    },
  };
  const clientCredentialsScheme: AuthScheme = {
    type: 'oauth2',
    flows: {
      clientCredentials: {
        tokenUrl: 'https://example.com/token',
        scopes: {},
      },
    },
  };
  const openIdScheme: AuthScheme = {
    type: 'openIdConnect',
    openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
  };

  it('converts an OAuth2 access token into an HTTP bearer credential', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();

    const result = await autoExchanger.exchange({
      authScheme: oauth2Scheme,
      authCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'oauth2-access-token'},
      },
    });

    expect(result).toEqual({
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'oauth2-access-token'}},
      },
      wasExchanged: true,
    });
  });

  it('converts an OpenID Connect access token into an HTTP bearer credential', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();

    const result = await autoExchanger.exchange({
      authScheme: openIdScheme,
      authCredential: {
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {accessToken: 'oidc-access-token'},
      },
    });

    expect(result).toEqual({
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'oidc-access-token'}},
      },
      wasExchanged: true,
    });
  });

  it('fetches a client-credentials token and converts it into an HTTP bearer credential', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'client-credentials-token',
          token_type: 'Bearer',
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      ),
    );
    const autoExchanger = new AutoAuthCredentialExchanger();

    const result = await autoExchanger.exchange({
      authScheme: clientCredentialsScheme,
      authCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
      },
    });

    expect(result).toEqual({
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'client-credentials-token'},
        },
      },
      wasExchanged: true,
    });
  });

  it('returns an unexchanged result for an authorization-code OAuth2 credential that holds no token', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };

    const result = await autoExchanger.exchange({
      authScheme: oauth2Scheme,
      authCredential,
    });

    expect(result).toEqual({credential: authCredential, wasExchanged: false});
  });

  it('returns an unexchanged result for an OpenID Connect credential that holds no token', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };

    const result = await autoExchanger.exchange({
      authScheme: openIdScheme,
      authCredential,
    });

    expect(result).toEqual({credential: authCredential, wasExchanged: false});
  });

  it('returns the delegate result when a custom exchanger returns no token', async () => {
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id'},
    };
    const passThroughExchanger = {
      exchange: vi.fn(
        async (_params: {
          authScheme?: AuthScheme;
          authCredential: AuthCredential;
        }): Promise<ExchangeResult> => ({
          credential: authCredential,
          wasExchanged: false,
        }),
      ),
    };
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.OAUTH2]: passThroughExchanger,
    });

    const result = await autoExchanger.exchange({
      authScheme: oauth2Scheme,
      authCredential,
    });

    expect(passThroughExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(result).toEqual({credential: authCredential, wasExchanged: false});
  });

  it('passes through an OAuth2 credential that already carries http', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      http: {scheme: 'bearer', credentials: {token: 'existing-token'}},
    };

    const result = await autoExchanger.exchange({
      authScheme: oauth2Scheme,
      authCredential,
    });

    expect(result).toEqual({credential: authCredential, wasExchanged: false});
    expect(result.credential).toBe(authCredential);
  });
});

describe('AutoAuthCredentialExchanger exchangers map', () => {
  it('exposes the default exchanger for each built-in type', () => {
    const autoExchanger = new AutoAuthCredentialExchanger();

    expect(
      autoExchanger.exchangers.get(AuthCredentialTypes.OAUTH2),
    ).toBeDefined();
    expect(
      autoExchanger.exchangers.get(AuthCredentialTypes.OPEN_ID_CONNECT),
    ).toBeDefined();
    expect(
      autoExchanger.exchangers.get(AuthCredentialTypes.SERVICE_ACCOUNT),
    ).toBeInstanceOf(ServiceAccountCredentialExchanger);
    expect(autoExchanger.exchangers.has(AuthCredentialTypes.API_KEY)).toBe(
      false,
    );
  });

  it('uses an exchanger added after construction', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();
    const mockExchanger = createMockExchanger(exchangedCredential);
    const authCredential = credentialOf(AuthCredentialTypes.API_KEY);

    autoExchanger.exchangers.set(AuthCredentialTypes.API_KEY, mockExchanger);
    const result = await autoExchanger.exchange({authScheme, authCredential});

    expect(mockExchanger.exchange).toHaveBeenCalledWith({
      authScheme,
      authCredential,
    });
    expect(result).toEqual({
      credential: exchangedCredential,
      wasExchanged: true,
    });
  });

  it('uses an exchanger that replaces a default after construction', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();
    const mockExchanger = createMockExchanger(exchangedCredential);

    autoExchanger.exchangers.set(AuthCredentialTypes.OAUTH2, mockExchanger);
    const result = await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OAUTH2),
    });

    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      credential: exchangedCredential,
      wasExchanged: true,
    });
  });
});
