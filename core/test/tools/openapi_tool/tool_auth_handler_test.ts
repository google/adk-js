/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialMissingError,
  AuthCredentialTypes,
  AuthScheme,
  BaseCredentialExchanger,
  Context,
  createSession,
  CredentialExchangeError,
  ExchangeResult,
  InMemorySessionService,
  InvocationContext,
  isAuthCredential,
  LlmAgent,
  OpenIdConnectWithConfig,
  PluginManager,
  ToolAuthHandler,
  ToolContextCredentialStore,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {State} from '../../../src/sessions/state.js';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';
import {logger} from '../../../src/utils/logger.js';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const OAUTH2_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    clientCredentials: {tokenUrl: 'https://example.com/token', scopes: {}},
  },
};

const OIDC_SCHEME: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
};

const OAUTH2_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
};

/** Stands in for a token endpoint that is briefly unreachable. */
class UnreachableExchanger implements BaseCredentialExchanger {
  async exchange(): Promise<ExchangeResult> {
    throw new CredentialExchangeError('token endpoint unreachable');
  }
}

/** The state key a handler built with this pair reads and writes. */
function cacheKeyFor(
  authScheme?: AuthScheme,
  authCredential?: AuthCredential,
): string {
  return new ToolContextCredentialStore(createToolContext()).getCredentialKey(
    authScheme,
    authCredential,
  );
}

/** A real tool context, so the credential request path is not stubbed out. */
function createToolContext(): Context {
  return new Context({
    functionCallId: 'test-fc-id',
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test', model: 'gemini-flash-latest'}),
      session: createSession({appName: 'test', userId: 'u', id: 's'}),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
  });
}

// Mock AutoAuthCredentialExchanger
vi.mock(
  '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js',
  () => {
    return {
      AutoAuthCredentialExchanger: vi.fn().mockImplementation(() => ({
        exchange: vi.fn().mockResolvedValue({
          credential: {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
          },
          wasExchanged: true,
        }),
      })),
    };
  },
);

describe('ToolAuthHandler', () => {
  it('should return done if no auth scheme', async () => {
    const mockContext = {} as unknown as Context;
    const handler = new ToolAuthHandler(mockContext);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential).toBeUndefined();
  });

  it('should return done after exchange if credential in context', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
  });

  it('should return pending and request credential if not in context', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(mockContext.requestCredential).toHaveBeenCalled();
  });

  it('should return cached credential if available', async () => {
    const mockContext = {
      state: new State({
        [cacheKeyFor({type: 'apiKey', name: 'X-API-Key', in: 'header'})]: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'cached-token'}},
        },
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe('cached-token');
  });

  it('reads a cached credential back through a real tool context', async () => {
    const context = createToolContext();
    const store = new ToolContextCredentialStore(context);
    store.storeCredential(store.getCredentialKey(API_KEY_SCHEME), {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'cached-token'}},
    });

    const result = await new ToolAuthHandler(
      context,
      API_KEY_SCHEME,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe('cached-token');
  });

  it('should store exchanged credential in state and record it in the delta', async () => {
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    // Stored via the State API so it is readable back through State.get...
    const stored = state.get<{http?: {credentials: {token: string}}}>(
      cacheKeyFor({type: 'apiKey', name: 'X-API-Key', in: 'header'}),
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
    // ...and recorded in the delta so it is persisted to the session (rather
    // than being re-exchanged on every subsequent tool call).
    expect(state.hasDelta()).toBe(true);
  });

  it('re-uses a credential persisted by a previous tool call instead of re-exchanging', async () => {
    // First invocation: exchange and store the credential.
    const firstState = new State();
    const firstContext = {
      state: firstState,
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;
    await new ToolAuthHandler(firstContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    }).prepareAuthCredentials();

    // Each tool call gets a fresh Context whose State is rebuilt from the
    // values persisted to the session. Only what was recorded in the state
    // delta/value survives this round-trip (a stray own-property would not).
    const secondState = new State(firstState.toRecord());
    const secondContext = {
      state: secondState,
      getAuthResponse: vi.fn(),
    } as unknown as Context;
    const result = await new ToolAuthHandler(secondContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    }).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
    // The cached credential was reused; no second exchange was triggered.
    expect(secondContext.getAuthResponse).not.toHaveBeenCalled();
  });

  it('uses the credential the tool was configured with instead of requesting one', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      {authType: AuthCredentialTypes.API_KEY, apiKey: 'static-key'},
    ).prepareAuthCredentials();

    // Schemes like apiKey need no user interaction, so asking the client for a
    // credential would leave the tool stuck in `pending` forever.
    expect(result.state).toBe('done');
    expect(mockContext.requestCredential).not.toHaveBeenCalled();
  });

  it('does not copy a static credential that needed no exchange into session state', async () => {
    const staticCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'static-key',
    };
    // The real exchanger has no exchanger registered for apiKey/http, so it
    // hands the credential straight back.
    vi.mocked(AutoAuthCredentialExchanger).mockImplementationOnce(
      () =>
        ({
          exchange: vi.fn().mockResolvedValue({
            credential: staticCredential,
            wasExchanged: false,
          }),
        }) as unknown as AutoAuthCredentialExchanger,
    );

    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      staticCredential,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.apiKey).toBe('static-key');
    // It is readable from the tool on every invocation, so persisting it would
    // only write the secret into the session store for nothing.
    expect(
      state.get(
        cacheKeyFor(
          {type: 'apiKey', name: 'X-API-Key', in: 'header'},
          staticCredential,
        ),
      ),
    ).toBeUndefined();
    expect(state.hasDelta()).toBe(false);
  });

  it('caches a static credential that did require an exchange', async () => {
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;
    const scheme: AuthScheme = {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    };
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };

    const result = await new ToolAuthHandler(
      mockContext,
      scheme,
      credential,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    // An exchange costs a round trip, so its result is worth persisting.
    const stored = state.get<{http?: {credentials: {token: string}}}>(
      cacheKeyFor(scheme, credential),
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
  });
});

describe('ToolAuthHandler OAuth2 and OIDC validation', () => {
  it('throws when an oauth2 scheme has no credential at all', async () => {
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    await expect(
      new ToolAuthHandler(context, OAUTH2_SCHEME).prepareAuthCredentials(),
    ).rejects.toThrow('authCredential is empty for scheme oauth2');
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('throws when an openIdConnect scheme has a credential without oauth2', async () => {
    const context = createToolContext();

    await expect(
      new ToolAuthHandler(
        context,
        OIDC_SCHEME,
        {authType: AuthCredentialTypes.OPEN_ID_CONNECT},
        {credentialExchanger: new UnreachableExchanger()},
      ).prepareAuthCredentials(),
    ).rejects.toThrow('authCredential is empty for scheme openIdConnect');
  });

  it('throws AuthCredentialMissingError when clientId is missing', async () => {
    const context = createToolContext();

    await expect(
      new ToolAuthHandler(
        context,
        OAUTH2_SCHEME,
        {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientSecret: 'client-secret'},
        },
        {credentialExchanger: new UnreachableExchanger()},
      ).prepareAuthCredentials(),
    ).rejects.toThrow(
      new AuthCredentialMissingError('OAuth2 credentials clientId is missing.'),
    );
  });

  it('throws AuthCredentialMissingError when clientSecret is missing', async () => {
    const context = createToolContext();

    await expect(
      new ToolAuthHandler(
        context,
        OAUTH2_SCHEME,
        {authType: AuthCredentialTypes.OAUTH2, oauth2: {clientId: 'client-id'}},
        {credentialExchanger: new UnreachableExchanger()},
      ).prepareAuthCredentials(),
    ).rejects.toThrow(
      new AuthCredentialMissingError(
        'OAuth2 credentials clientSecret is missing.',
      ),
    );
  });

  it('does not apply the OAuth2 checks to a non-interactive scheme', async () => {
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    // An apiKey scheme needs no client credentials, so a credential without
    // `oauth2` is normal rather than a configuration mistake.
    const result = await new ToolAuthHandler(
      context,
      API_KEY_SCHEME,
      {authType: AuthCredentialTypes.API_KEY},
      {credentialExchanger: new UnreachableExchanger()},
    ).prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(requestCredential).toHaveBeenCalledOnce();
  });
});

describe('ToolAuthHandler exchange failure', () => {
  it('turns a throwing exchanger into pending and logs the failure', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    const result = await new ToolAuthHandler(
      context,
      OAUTH2_SCHEME,
      OAUTH2_CREDENTIAL,
      {credentialExchanger: new UnreachableExchanger()},
    ).prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(result.authCredential).toEqual(OAUTH2_CREDENTIAL);
    expect(requestCredential).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to exchange credential: token endpoint unreachable',
    );
    errorSpy.mockRestore();
  });

  it('logs a thrown non-Error value without failing', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const context = createToolContext();
    const exchanger: BaseCredentialExchanger = {
      exchange: vi.fn().mockRejectedValue('plain string failure'),
    };

    const result = await new ToolAuthHandler(
      context,
      API_KEY_SCHEME,
      {authType: AuthCredentialTypes.API_KEY, apiKey: 'k'},
      {credentialExchanger: exchanger},
    ).prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to exchange credential: plain string failure',
    );
    errorSpy.mockRestore();
  });
});

describe('ToolContextCredentialStore', () => {
  function storeOverNewContext(): {
    store: ToolContextCredentialStore;
    context: Context;
  } {
    const context = createToolContext();
    return {store: new ToolContextCredentialStore(context), context};
  }

  it('gives two apiKey schemes with different names different keys', async () => {
    const otherScheme: AuthScheme = {
      type: 'apiKey',
      name: 'X-Other-Key',
      in: 'header',
    };
    const {store, context} = storeOverNewContext();

    expect(store.getCredentialKey(API_KEY_SCHEME)).not.toBe(
      store.getCredentialKey(otherScheme),
    );

    // A credential cached for the first scheme is invisible to the second.
    vi.spyOn(context, 'getAuthResponse').mockReturnValue({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'first-key',
    });
    await new ToolAuthHandler(context, API_KEY_SCHEME).prepareAuthCredentials();

    expect(store.getCredential(API_KEY_SCHEME)).toBeDefined();
    expect(store.getCredential(otherScheme)).toBeUndefined();
  });

  it('gives one scheme with two different credentials different keys', () => {
    const {store} = storeOverNewContext();
    const first: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'first',
    };
    const second: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'second',
    };

    expect(store.getCredentialKey(API_KEY_SCHEME, first)).not.toBe(
      store.getCredentialKey(API_KEY_SCHEME, second),
    );
  });

  it('does not hand one credential the token exchanged for another', async () => {
    // Two tools share a scheme and differ only in the credential. The first
    // exchanges and caches; the second must not read that token back.
    const context = createToolContext();
    const first: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'first-client', clientSecret: 'first-secret'},
    };
    const second: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'second-client', clientSecret: 'second-secret'},
    };
    await new ToolAuthHandler(
      context,
      OAUTH2_SCHEME,
      first,
    ).prepareAuthCredentials();

    const result = await new ToolAuthHandler(context, OAUTH2_SCHEME, second, {
      credentialExchanger: {
        exchange: vi.fn().mockResolvedValue({
          credential: {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', credentials: {token: 'second-token'}},
          },
          wasExchanged: true,
        }),
      },
    }).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe('second-token');
  });

  it('leaves out the segment for an operand it was not given', () => {
    const {store} = storeOverNewContext();

    expect(store.getCredentialKey()).toBe('__existing_exchanged_credential');
    // Scheme only: the scheme segment is filled and the credential one is not.
    expect(store.getCredentialKey(API_KEY_SCHEME)).toMatch(
      /^apiKey_[0-9a-f]+__existing_exchanged_credential$/,
    );
    // Credential only: the other way round.
    expect(store.getCredentialKey(undefined, OAUTH2_CREDENTIAL)).toMatch(
      /^_oauth2_[0-9a-f]+_existing_exchanged_credential$/,
    );
  });

  it('builds the same key whatever order the fields were assigned in', () => {
    const {store} = storeOverNewContext();
    const reordered: AuthScheme = {
      in: 'header',
      name: 'X-API-Key',
      type: 'apiKey',
    };

    expect(store.getCredentialKey(reordered)).toBe(
      store.getCredentialKey(API_KEY_SCHEME),
    );
  });

  it('makes a removed credential unreadable', () => {
    const {store} = storeOverNewContext();
    const key = store.getCredentialKey(API_KEY_SCHEME, OAUTH2_CREDENTIAL);
    store.storeCredential(key, {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'tok'}},
    });
    expect(
      store.getCredential(API_KEY_SCHEME, OAUTH2_CREDENTIAL),
    ).toBeDefined();

    store.removeCredential(key);

    expect(
      store.getCredential(API_KEY_SCHEME, OAUTH2_CREDENTIAL),
    ).toBeUndefined();
  });

  it('drops undefined members when storing', () => {
    const {store, context} = storeOverNewContext();
    const key = store.getCredentialKey(API_KEY_SCHEME);
    store.storeCredential(key, {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'k',
      resourceRef: undefined,
    });

    expect(Object.keys(context.state.get<object>(key) ?? {})).toEqual([
      'authType',
      'apiKey',
    ]);
  });

  it.each([
    ['a string', 'not-a-credential'],
    ['an object without authType', {foo: 'bar'}],
    ['an unknown authType', {authType: 'notAScheme'}],
  ])('throws when the state entry is %s', (_name, stored) => {
    const {store, context} = storeOverNewContext();
    const key = store.getCredentialKey(API_KEY_SCHEME);
    context.state.set(key, stored);

    expect(() => store.getCredential(API_KEY_SCHEME)).toThrow(key);
  });

  it('returns undefined for a null state entry', () => {
    const {store, context} = storeOverNewContext();
    context.state.set(store.getCredentialKey(API_KEY_SCHEME), null);

    expect(store.getCredential(API_KEY_SCHEME)).toBeUndefined();
  });
});

describe('ToolAuthHandler collaborators', () => {
  it('uses an injected credential store instead of building one', async () => {
    const injectedStore = new ToolContextCredentialStore(createToolContext());
    injectedStore.storeCredential(
      injectedStore.getCredentialKey(API_KEY_SCHEME),
      {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'injected-token'}},
      },
    );
    // This context's own state holds nothing, so a handler that built its own
    // store would miss.
    const context = createToolContext();

    const result = await new ToolAuthHandler(
      context,
      API_KEY_SCHEME,
      undefined,
      {credentialStore: injectedStore},
    ).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe(
      'injected-token',
    );
  });

  it('passes the exchanger and the store through fromToolContext', async () => {
    const context = createToolContext();
    const store = new ToolContextCredentialStore(context);
    const exchanger: BaseCredentialExchanger = {
      exchange: vi.fn().mockResolvedValue({
        credential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'from-injected'}},
        },
        wasExchanged: true,
      }),
    };

    const result = await ToolAuthHandler.fromToolContext(
      context,
      API_KEY_SCHEME,
      {authType: AuthCredentialTypes.API_KEY, apiKey: 'k'},
      {credentialKey: 'my-key', credentialExchanger: exchanger},
    ).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe(
      'from-injected',
    );
    expect(exchanger.exchange).toHaveBeenCalledOnce();
    // The exchanged credential landed in the store that was passed in.
    expect(
      store.getCredential(API_KEY_SCHEME, {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'k',
      }),
    ).toEqual(result.authCredential);
  });

  it('ignores mutation of the scheme and credential after construction', async () => {
    const scheme: AuthScheme = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'original',
    };
    const context = createToolContext();
    const store = new ToolContextCredentialStore(context);
    const keyBefore = store.getCredentialKey(scheme, credential);
    vi.spyOn(context, 'getAuthResponse').mockReturnValue({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'from-response',
    });

    const handler = new ToolAuthHandler(context, scheme, credential);
    // The caller keeps the objects it passed in and edits them.
    scheme.name = 'X-Mutated-Key';
    credential.apiKey = 'mutated';

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    // The credential was cached under the key the handler was built with.
    expect(context.state.get(keyBefore)).toBeDefined();
    expect(result.authScheme).toEqual({
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });
  });

  it('carries the auth scheme on every result that has one', async () => {
    const pendingContext = createToolContext();
    const doneContext = createToolContext();
    vi.spyOn(doneContext, 'getAuthResponse').mockReturnValue({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key',
    });

    const pending = await new ToolAuthHandler(
      pendingContext,
      API_KEY_SCHEME,
    ).prepareAuthCredentials();
    const done = await new ToolAuthHandler(
      doneContext,
      API_KEY_SCHEME,
    ).prepareAuthCredentials();
    // The third handler reads the credential the second one cached.
    const cached = await new ToolAuthHandler(
      doneContext,
      API_KEY_SCHEME,
    ).prepareAuthCredentials();

    expect(pending.state).toBe('pending');
    expect(pending.authScheme).toEqual(API_KEY_SCHEME);
    expect(done.authScheme).toEqual(API_KEY_SCHEME);
    expect(cached.authScheme).toEqual(API_KEY_SCHEME);
  });
});

describe('isAuthCredential', () => {
  it('accepts every declared credential type', () => {
    for (const authType of Object.values(AuthCredentialTypes)) {
      expect(isAuthCredential({authType})).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'apiKey'],
    ['an object without authType', {apiKey: 'k'}],
    ['an unknown authType', {authType: 'somethingElse'}],
  ])('rejects %s', (_name, value) => {
    expect(isAuthCredential(value)).toBe(false);
  });
});

/**
 * The three cases below are ported from `google/adk-python` at tag `v0.1.0`,
 * `src/google/adk/tests/unittests/tools/openapi_tool/openapi_spec_parser/test_tool_auth_handler.py`.
 * That file has three test functions and all three are here, keeping their
 * names verbatim so a reviewer can grep the original.
 */

/**
 * Stands in for `MockOpenIdConnectCredentialExchanger` in the reference test.
 *
 * adk-python returns `None` to mean "cannot exchange yet". `ExchangeResult`
 * makes `credential` non-nullable, so this signals the same thing by throwing
 * `CredentialExchangeError`, which `prepareAuthCredentials` maps to `pending`.
 */
class MockOpenIdConnectCredentialExchanger {
  constructor(private readonly expectedAccessToken: string | undefined) {}

  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const oauth2 = params.authCredential.oauth2;
    const authCode = oauth2?.authResponseUri ?? oauth2?.authCode;
    if (!authCode) {
      throw new CredentialExchangeError('No auth response to exchange yet.');
    }
    return {
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: authCode + this.expectedAccessToken},
        },
      },
      wasExchanged: true,
    };
  }
}

/**
 * The reference builds these with `openid_dict_to_scheme_credential` and
 * `token_to_scheme_credential` from `auth_helpers.py`. adk-js has neither
 * helper, so the equivalent literals are built here.
 *
 * The endpoints are absolute URLs where the reference writes the bare host
 * `test.com`. `AuthHandler.generateAuthUri` parses the endpoint with `new URL`
 * and rejects a relative one, while adk-python concatenates the query string
 * onto whatever string it is given. That difference belongs to `AuthHandler`,
 * not to `ToolAuthHandler`, so the fixture accommodates it.
 */
function getMockOpenidSchemeCredential(): {
  scheme: OpenIdConnectWithConfig;
  credential: AuthCredential;
} {
  return {
    scheme: {
      type: 'openIdConnect',
      openIdConnectUrl: '',
      authorizationEndpoint: 'https://test.com',
      tokenEndpoint: 'https://test.com',
      scopes: ['test_scope'],
    },
    credential: {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: '123',
        clientSecret: '456',
        redirectUri: 'https://test.com',
      },
    },
  };
}

describe('ToolAuthHandler (adk-python v0.1.0 parity)', () => {
  it('test_openid_connect_no_auth_response', async () => {
    const {scheme, credential} = getMockOpenidSchemeCredential();
    const mockExchanger = new MockOpenIdConnectCredentialExchanger(undefined);
    const context = createToolContext();

    const handler = new ToolAuthHandler(context, scheme, credential, {
      credentialExchanger: mockExchanger,
    });
    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(result.authCredential).toEqual(credential);
  });

  it('test_openid_connect_with_auth_response', async () => {
    const {scheme, credential} = getMockOpenidSchemeCredential();
    const mockExchanger = new MockOpenIdConnectCredentialExchanger(
      'test_access_token',
    );
    const context = createToolContext();
    // adk-python monkeypatches `google.adk.tools.tool_context.AuthHandler`.
    // The adk-js equivalent is stubbing the method that reads the response.
    const getAuthResponse = vi
      .spyOn(context, 'getAuthResponse')
      .mockReturnValue({
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {authResponseUri: 'test_auth_response_uri'},
      });
    const credentialStore = new ToolContextCredentialStore(context);

    const handler = new ToolAuthHandler(context, scheme, credential, {
      credentialExchanger: mockExchanger,
    });
    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.authType).toBe(AuthCredentialTypes.HTTP);
    expect(result.authCredential?.http?.credentials.token).toContain(
      'test_access_token',
    );
    expect(credentialStore.getCredential(scheme, credential)).toEqual(
      result.authCredential,
    );
    expect(getAuthResponse).toHaveBeenCalledOnce();
  });

  it('test_openid_connect_existing_token', async () => {
    const {scheme, credential} = getMockOpenidSchemeCredential();
    const existingCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: '123123123'}},
    };
    const context = createToolContext();
    const credentialStore = new ToolContextCredentialStore(context);
    const key = credentialStore.getCredentialKey(scheme, credential);
    credentialStore.storeCredential(key, existingCredential);

    const handler = new ToolAuthHandler(context, scheme, credential);
    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential).toEqual(existingCredential);
  });
});
