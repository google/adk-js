/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  credentialToParam,
  INTERNAL_AUTH_PREFIX,
  OpenIdConfig,
  openidRecordToSchemeCredential,
  openidUrlToSchemeCredential,
  recordToAuthScheme,
  ServiceAccount,
  serviceAccountRecordToSchemeCredential,
  serviceAccountSchemeCredential,
  tokenToSchemeCredential,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const BEARER_JWT_SCHEME = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
};

const OPENID_CREDENTIAL_RECORD = {
  client_id: 'client_id',
  client_secret: 'client_secret',
  redirect_uri: 'redirect_uri',
};

const SCOPES = ['scope1', 'scope2'];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'},
  });
}

describe('auth helpers', () => {
  it('builds an apiKey header scheme and credential', () => {
    const [scheme, credential] = tokenToSchemeCredential(
      'apikey',
      'header',
      'X-API-Key',
      'test_key',
    );

    expect(scheme).toEqual({type: 'apiKey', in: 'header', name: 'X-API-Key'});
    expect(credential).toEqual({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    });
  });

  it('builds an apiKey query scheme and credential', () => {
    const [scheme, credential] = tokenToSchemeCredential(
      'apikey',
      'query',
      'api_key',
      'test_key',
    );

    expect(scheme).toEqual({type: 'apiKey', in: 'query', name: 'api_key'});
    expect(credential).toEqual({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    });
  });

  it('builds an apiKey cookie scheme and credential', () => {
    const [scheme, credential] = tokenToSchemeCredential(
      'apikey',
      'cookie',
      'session_id',
      'test_key',
    );

    expect(scheme).toEqual({type: 'apiKey', in: 'cookie', name: 'session_id'});
    expect(credential).toEqual({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    });
  });

  it('builds an apiKey scheme without a credential when value is omitted', () => {
    const [scheme, credential] = tokenToSchemeCredential(
      'apikey',
      'cookie',
      'session_id',
    );

    expect(scheme).toEqual({type: 'apiKey', in: 'cookie', name: 'session_id'});
    expect(credential).toBeUndefined();
  });

  it('builds a bearer JWT scheme and HTTP credential for an oauth2Token', () => {
    const [scheme, credential] = tokenToSchemeCredential(
      'oauth2Token',
      'header',
      'Authorization',
      'test_token',
    );

    expect(scheme).toEqual(BEARER_JWT_SCHEME);
    expect(credential).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    });
  });

  it('builds a bearer JWT scheme without a credential when oauth2Token value is omitted', () => {
    const [scheme, credential] = tokenToSchemeCredential(
      'oauth2Token',
      'header',
      'Authorization',
    );

    expect(scheme).toEqual(BEARER_JWT_SCHEME);
    expect(credential).toBeUndefined();
  });

  it('builds a bearer scheme and service-account credential from a key record', () => {
    const config = {
      type: 'service_account',
      project_id: 'project_id',
      private_key_id: 'private_key_id',
      private_key: 'private_key',
      client_email: 'client_email',
      client_id: 'client_id',
      auth_uri: 'auth_uri',
      token_uri: 'token_uri',
      auth_provider_x509_cert_url: 'auth_provider_x509_cert_url',
      client_x509_cert_url: 'client_x509_cert_url',
      universe_domain: 'universe_domain',
    };

    const [scheme, credential] = serviceAccountRecordToSchemeCredential(
      config,
      SCOPES,
    );

    expect(scheme).toEqual(BEARER_JWT_SCHEME);
    expect(credential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
    expect(credential.serviceAccount?.scopes).toEqual(SCOPES);
    expect(credential.serviceAccount?.serviceAccountCredential?.projectId).toBe(
      'project_id',
    );
  });

  it('builds a bearer scheme and service-account credential from a ServiceAccount object', () => {
    const config: ServiceAccount = {
      serviceAccountCredential: {
        type: 'service_account',
        projectId: 'project_id',
        privateKeyId: 'private_key_id',
        privateKey: 'private_key',
        clientEmail: 'client_email',
        clientId: 'client_id',
        authUri: 'auth_uri',
        tokenUri: 'token_uri',
        authProviderX509CertUrl: 'auth_provider_x509_cert_url',
        clientX509CertUrl: 'client_x509_cert_url',
        universeDomain: 'universe_domain',
      },
      scopes: SCOPES,
    };

    const [scheme, credential] = serviceAccountSchemeCredential(config);

    expect(scheme).toEqual(BEARER_JWT_SCHEME);
    expect(credential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
    expect(credential.serviceAccount).toEqual(config);
  });

  it('builds an OpenID Connect scheme and credential from config and credential records', () => {
    const configRecord = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
      openIdConnectUrl: 'openid_url',
    };

    const [scheme, credential] = openidRecordToSchemeCredential(
      configRecord,
      SCOPES,
      OPENID_CREDENTIAL_RECORD,
    );

    expect(scheme.authorizationEndpoint).toBe('auth_url');
    expect(scheme.tokenEndpoint).toBe('token_url');
    expect(scheme.scopes).toEqual(SCOPES);
    expect(credential.authType).toBe(AuthCredentialTypes.OPEN_ID_CONNECT);
    expect(credential.oauth2?.clientId).toBe('client_id');
    expect(credential.oauth2?.clientSecret).toBe('client_secret');
    expect(credential.oauth2?.redirectUri).toBe('redirect_uri');
  });

  it('defaults openIdConnectUrl to an empty string when omitted from configRecord', () => {
    const configRecord = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
    };

    const [scheme] = openidRecordToSchemeCredential(
      configRecord,
      SCOPES,
      OPENID_CREDENTIAL_RECORD,
    );

    expect(scheme.openIdConnectUrl).toBe('');
  });

  it('unwraps a Google OAuth web client credential record', () => {
    const configRecord = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
      openIdConnectUrl: 'openid_url',
    };
    const credentialRecord = {web: OPENID_CREDENTIAL_RECORD};

    const [scheme, credential] = openidRecordToSchemeCredential(
      configRecord,
      SCOPES,
      credentialRecord,
    );

    expect(scheme.type).toBe('openIdConnect');
    expect(credential.authType).toBe(AuthCredentialTypes.OPEN_ID_CONNECT);
    expect(credential.oauth2?.clientId).toBe('client_id');
    expect(credential.oauth2?.clientSecret).toBe('client_secret');
    expect(credential.oauth2?.redirectUri).toBe('redirect_uri');
  });

  it('throws when the OpenID Connect configuration is invalid', () => {
    expect(() =>
      openidRecordToSchemeCredential({invalid_field: 'value'}, SCOPES, {
        client_id: 'client_id',
        client_secret: 'client_secret',
      }),
    ).toThrow(/Invalid OpenID Connect configuration/);
  });

  it('throws when required credential fields are missing from credentialRecord', () => {
    const configRecord = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
    };

    expect(() =>
      openidRecordToSchemeCredential(configRecord, SCOPES, {
        client_id: 'client_id',
      }),
    ).toThrow('Missing required fields in credentialRecord: client_secret');
  });

  describe('openidUrlToSchemeCredential', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('fetches discovery configuration and builds the OpenID scheme and credential', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          authorization_endpoint: 'auth_url',
          token_endpoint: 'token_url',
          userinfo_endpoint: 'userinfo_url',
        }),
      );

      const [scheme, credential] = await openidUrlToSchemeCredential(
        'openid_url',
        SCOPES,
        OPENID_CREDENTIAL_RECORD,
      );

      expect(scheme.authorizationEndpoint).toBe('auth_url');
      expect(scheme.tokenEndpoint).toBe('token_url');
      expect(scheme.scopes).toEqual(SCOPES);
      expect(credential.authType).toBe(AuthCredentialTypes.OPEN_ID_CONNECT);
      expect(credential.oauth2?.clientId).toBe('client_id');
      expect(credential.oauth2?.clientSecret).toBe('client_secret');
      expect(credential.oauth2?.redirectUri).toBe('redirect_uri');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('openid_url');
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeDefined();
    });

    it('sets openIdConnectUrl on the scheme to the fetched URL', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          authorization_endpoint: 'auth_url',
          token_endpoint: 'token_url',
          userinfo_endpoint: 'userinfo_url',
        }),
      );

      const [scheme] = await openidUrlToSchemeCredential(
        'openid_url',
        SCOPES,
        OPENID_CREDENTIAL_RECORD,
      );

      expect(scheme.openIdConnectUrl).toBe('openid_url');
    });

    it('throws when the discovery request rejects', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Test Error'));

      await expect(
        openidUrlToSchemeCredential('openid_url', [], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).rejects.toThrow('Failed to fetch OpenID configuration from openid_url');
    });

    it('throws when the discovery response body is not valid JSON', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('not json', {status: 200}),
      );

      await expect(
        openidUrlToSchemeCredential('openid_url', [], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).rejects.toThrow(
        'Invalid JSON response from OpenID configuration endpoint openid_url',
      );
    });
  });

  it('converts an apiKey header credential into an auth parameter', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('X-API-Key');
    expect(param?.paramLocation).toBe('header');
    expect(paramValues).toEqual({
      [`${INTERNAL_AUTH_PREFIX}X-API-Key`]: 'test_key',
    });
  });

  it('converts an apiKey query credential into an auth parameter', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'query',
      name: 'api_key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('api_key');
    expect(param?.paramLocation).toBe('query');
    expect(paramValues).toEqual({
      [`${INTERNAL_AUTH_PREFIX}api_key`]: 'test_key',
    });
  });

  it('converts an apiKey cookie credential into an auth parameter', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'cookie',
      name: 'session_id',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('session_id');
    expect(param?.paramLocation).toBe('cookie');
    expect(paramValues).toEqual({
      [`${INTERNAL_AUTH_PREFIX}session_id`]: 'test_key',
    });
  });

  it('converts an HTTP bearer credential into an Authorization header parameter', () => {
    const authScheme: AuthScheme = {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('Authorization');
    expect(param?.paramLocation).toBe('header');
    expect(paramValues).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('rejects HTTP basic authentication in credentialToParam', () => {
    const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'basic',
        credentials: {username: 'user', password: 'password'},
      },
    };

    expect(() => credentialToParam(authScheme, authCredential)).toThrow(
      'Basic Authentication is not supported.',
    );
  });

  it('rejects an HTTP credential with no http field', () => {
    const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
    };

    expect(() => credentialToParam(authScheme, authCredential)).toThrow(
      'Invalid HTTP auth credentials',
    );
  });

  it('converts an exchanged OAuth2 bearer token into an Authorization header parameter', () => {
    const authScheme: AuthScheme = {type: 'oauth2', flows: {}};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('Authorization');
    expect(param?.paramLocation).toBe('header');
    expect(paramValues).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('converts an exchanged OpenID Connect bearer token into an Authorization header parameter', () => {
    const authScheme: AuthScheme = {
      type: 'openIdConnect',
      openIdConnectUrl: 'openid_url',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('Authorization');
    expect(param?.paramLocation).toBe('header');
    expect(paramValues).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('returns undefined pair for an OpenID Connect scheme when credential is omitted', () => {
    const authScheme: AuthScheme = {
      type: 'openIdConnect',
      openIdConnectUrl: 'openid_url',
    };

    const [param, paramValues] = credentialToParam(authScheme, undefined);

    expect(param).toBeUndefined();
    expect(paramValues).toBeUndefined();
  });

  it('returns undefined pair for an OAuth2 scheme when credential is omitted', () => {
    const authScheme: AuthScheme = {type: 'oauth2', flows: {}};

    const [param, paramValues] = credentialToParam(authScheme, undefined);

    expect(param).toBeUndefined();
    expect(paramValues).toBeUndefined();
  });

  it('parses an apiKey security scheme object', () => {
    const scheme = recordToAuthScheme({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });

    expect(scheme).toEqual({type: 'apiKey', in: 'header', name: 'X-API-Key'});
  });

  it('parses an HTTP bearer security scheme object', () => {
    const scheme = recordToAuthScheme({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });

    expect(scheme).toEqual(BEARER_JWT_SCHEME);
  });

  it('parses an HTTP basic security scheme object', () => {
    const scheme = recordToAuthScheme({type: 'http', scheme: 'basic'});

    expect(scheme).toEqual({type: 'http', scheme: 'basic'});
  });

  it('parses an OAuth2 security scheme object and defaults flow scopes', () => {
    const scheme = recordToAuthScheme({
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
        },
      },
    });

    expect(scheme).toEqual({
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    });
  });

  it('parses an OpenID Connect security scheme object', () => {
    const scheme = recordToAuthScheme({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
    });

    expect(scheme).toEqual({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
    });
  });

  it('throws when the security scheme object omits type', () => {
    expect(() => recordToAuthScheme({in: 'header', name: 'X-API-Key'})).toThrow(
      "Missing 'type' field in security scheme object.",
    );
  });

  it('throws when the security scheme type is unsupported', () => {
    expect(() =>
      recordToAuthScheme({type: 'invalid', in: 'header', name: 'X-API-Key'}),
    ).toThrow('Invalid security scheme type: invalid');
  });

  it('throws when the security scheme object fails schema validation', () => {
    expect(() => recordToAuthScheme({type: 'apiKey', in: 'header'})).toThrow(
      /Invalid security scheme data/,
    );
  });
});

const CREDENTIAL_RECORD = {
  client_id: 'client_id',
  client_secret: 'client_secret',
};

describe('INTERNAL_AUTH_PREFIX', () => {
  it('uses the expected internal auth parameter prefix', () => {
    // Every other assertion builds its expectation from the constant, so only
    // this one catches a change to the value itself.
    expect(INTERNAL_AUTH_PREFIX).toBe('_auth_prefix_vaf_');
  });
});

describe('tokenToSchemeCredential', () => {
  it('rejects an apiKey with no location', () => {
    expect(() => tokenToSchemeCredential('apikey')).toThrow(
      'Invalid location for apiKey: undefined',
    );
  });

  it('rejects an unsupported token type', () => {
    // The parameter union makes this unreachable from TypeScript. The guard
    // exists for JavaScript callers, so the test calls it the way one would.
    const tokenType: string = 'basic';

    expect(() =>
      tokenToSchemeCredential(
        tokenType as Parameters<typeof tokenToSchemeCredential>[0],
      ),
    ).toThrow('Invalid security scheme type: basic');
  });

  it('defaults the apiKey name to an empty string', () => {
    const [scheme] = tokenToSchemeCredential('apikey', 'header');

    expect(scheme).toEqual({type: 'apiKey', in: 'header', name: ''});
  });
});

describe('openidRecordToSchemeCredential', () => {
  it('accepts a snake_case discovery document and its camelCase equivalent', () => {
    const snakeCase = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
      userinfo_endpoint: 'userinfo_url',
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      grant_types_supported: ['authorization_code'],
      revocation_endpoint: 'revoke_url',
    };
    const camelCase = {
      authorizationEndpoint: 'auth_url',
      tokenEndpoint: 'token_url',
      userinfoEndpoint: 'userinfo_url',
      tokenEndpointAuthMethodsSupported: ['client_secret_post'],
      grantTypesSupported: ['authorization_code'],
      revocationEndpoint: 'revoke_url',
    };

    const [fromSnakeCase] = openidRecordToSchemeCredential(
      snakeCase,
      ['openid'],
      CREDENTIAL_RECORD,
    );
    const [fromCamelCase] = openidRecordToSchemeCredential(
      camelCase,
      ['openid'],
      CREDENTIAL_RECORD,
    );

    expect(fromSnakeCase).toEqual(fromCamelCase);
    expect(fromSnakeCase.userinfoEndpoint).toBe('userinfo_url');
    expect(fromSnakeCase.tokenEndpointAuthMethodsSupported).toEqual([
      'client_secret_post',
    ]);
  });

  it('leaves redirectUri undefined when the credential omits it', () => {
    const [, credential] = openidRecordToSchemeCredential(
      {authorization_endpoint: 'auth_url', token_endpoint: 'token_url'},
      [],
      CREDENTIAL_RECORD,
    );

    expect(credential.oauth2?.redirectUri).toBeUndefined();
  });

  it('keeps a single-valued credential that is not a client-secret wrapper', () => {
    expect(() =>
      openidRecordToSchemeCredential(
        {authorization_endpoint: 'auth_url', token_endpoint: 'token_url'},
        [],
        {installed: {client_id: 'client_id'}},
      ),
    ).toThrow(
      'Missing required fields in credentialRecord: client_id, client_secret',
    );
  });

  it('keeps a single-valued credential whose value is not an object', () => {
    expect(() =>
      openidRecordToSchemeCredential(
        {authorization_endpoint: 'auth_url', token_endpoint: 'token_url'},
        [],
        {web: 'not an object'},
      ),
    ).toThrow(
      'Missing required fields in credentialRecord: client_id, client_secret',
    );
  });
});

describe('openidUrlToSchemeCredential', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the status of a response that is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', {status: 500}));

    await expect(
      openidUrlToSchemeCredential('openid_url', [], CREDENTIAL_RECORD),
    ).rejects.toThrow(
      'Failed to fetch OpenID configuration from openid_url: responded with status 500',
    );
  });

  it('rejects a JSON body that is not an object', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('[1, 2]', {status: 200}));

    await expect(
      openidUrlToSchemeCredential('openid_url', [], CREDENTIAL_RECORD),
    ).rejects.toThrow(
      'Invalid JSON response from OpenID configuration endpoint openid_url',
    );
  });
});

describe('credentialToParam', () => {
  it('rejects an apiKey scheme with an unsupported location', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'body',
      name: 'X-API-Key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    expect(() => credentialToParam(authScheme, authCredential)).toThrow(
      'Invalid API Key location: body',
    );
  });

  it('uses the scheme description for an apiKey parameter', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      description: 'The service key.',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param] = credentialToParam(authScheme, authCredential);

    expect(param?.description).toBe('The service key.');
    expect(param?.name).toBe(`${INTERNAL_AUTH_PREFIX}X-API-Key`);
    expect(param?.required).toBe(true);
  });

  it('defaults the apiKey parameter description to an empty string', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param] = credentialToParam(authScheme, authCredential);

    expect(param?.description).toBe('');
  });

  it('names an apiKey parameter with the prefix alone when the scheme has no name', () => {
    const authScheme: AuthScheme = {type: 'apiKey', in: 'header', name: ''};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('');
    expect(paramValues).toEqual({[INTERNAL_AUTH_PREFIX]: 'test_key'});
  });

  it('uses the scheme description for a bearer parameter', () => {
    const authScheme: AuthScheme = {
      type: 'http',
      scheme: 'bearer',
      description: 'The service token.',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    };

    const [param] = credentialToParam(authScheme, authCredential);

    expect(param?.description).toBe('The service token.');
    expect(param?.required).toBe(true);
  });

  it('rejects an HTTP credential whose credentials are empty', () => {
    const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'basic', credentials: {}},
    };

    expect(() => credentialToParam(authScheme, authCredential)).toThrow(
      'Invalid HTTP auth credentials',
    );
  });

  it('rejects basic auth given only a password', () => {
    const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'basic', credentials: {password: 'password'}},
    };

    expect(() => credentialToParam(authScheme, authCredential)).toThrow(
      'Basic Authentication is not supported.',
    );
  });

  it('builds a bearer parameter for a non-HTTP openIdConnect credential', () => {
    const authScheme: AuthScheme = {
      type: 'openIdConnect',
      openIdConnectUrl: 'openid_url',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('Authorization');
    expect(paramValues).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('returns nothing for an unexchanged oauth2 credential', () => {
    const authScheme: AuthScheme = {type: 'oauth2', flows: {}};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client_id'},
    };

    const [param, paramValues] = credentialToParam(authScheme, authCredential);

    expect(param).toBeUndefined();
    expect(paramValues).toBeUndefined();
  });

  it('rejects an apiKey scheme paired with a service-account credential', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    expect(() => credentialToParam(authScheme, authCredential)).toThrow(
      'Invalid security scheme and credential combination',
    );
  });
});

describe('recordToAuthScheme', () => {
  it('rejects oauth2 with no flows', () => {
    expect(() => recordToAuthScheme({type: 'oauth2'})).toThrow(
      /Invalid security scheme data/,
    );
  });

  it('rejects openIdConnect with no openIdConnectUrl', () => {
    expect(() => recordToAuthScheme({type: 'openIdConnect'})).toThrow(
      /Invalid security scheme data/,
    );
  });

  it('rejects an apiKey location outside header, query and cookie', () => {
    expect(() =>
      recordToAuthScheme({type: 'apiKey', in: 'body', name: 'X-API-Key'}),
    ).toThrow(/Invalid security scheme data/);
  });

  it('rejects a bearer scheme whose bearerFormat is not a string', () => {
    expect(() =>
      recordToAuthScheme({type: 'http', scheme: 'bearer', bearerFormat: 7}),
    ).toThrow(/Invalid security scheme data/);
  });

  it('rejects an http scheme with no scheme field', () => {
    expect(() => recordToAuthScheme({type: 'http'})).toThrow(
      /Invalid security scheme data/,
    );
  });

  it('keeps unknown keys on a validated scheme', () => {
    const scheme = recordToAuthScheme({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      'x-vendor-hint': 'keep me',
    });

    expect(scheme).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      'x-vendor-hint': 'keep me',
    });
  });
});

describe('credentialToParam bearer description', () => {
  const bearerCredential: AuthCredential = {
    authType: AuthCredentialTypes.HTTP,
    http: {scheme: 'bearer', credentials: {token: 'test_token'}},
  };

  it('falls back to Bearer token for an empty HTTP scheme description', () => {
    const authScheme: AuthScheme = {
      type: 'http',
      scheme: 'bearer',
      description: '',
    };

    const [param] = credentialToParam(authScheme, bearerCredential);

    expect(param?.description).toBe('Bearer token');
  });

  it('falls back to Bearer token for an empty OAuth2 scheme description', () => {
    const authScheme: AuthScheme = {type: 'oauth2', flows: {}, description: ''};

    const [param] = credentialToParam(authScheme, bearerCredential);

    expect(param?.description).toBe('Bearer token');
  });

  it('keeps a non-empty scheme description', () => {
    const authScheme: AuthScheme = {
      type: 'http',
      scheme: 'bearer',
      description: 'Service token',
    };

    const [param] = credentialToParam(authScheme, bearerCredential);

    expect(param?.description).toBe('Service token');
  });
});

describe('OpenIdConfig', () => {
  it('accepts a config without a redirect URI', () => {
    const config: OpenIdConfig = {
      clientId: 'client_id',
      authUri: 'https://example.com/auth',
      tokenUri: 'https://example.com/token',
      clientSecret: 'client_secret',
    };

    expect(config.redirectUri).toBeUndefined();
  });

  it('accepts a config with a redirect URI', () => {
    const config: OpenIdConfig = {
      clientId: 'client_id',
      authUri: 'https://example.com/auth',
      tokenUri: 'https://example.com/token',
      clientSecret: 'client_secret',
      redirectUri: 'https://example.com/callback',
    };

    expect(config.redirectUri).toBe('https://example.com/callback');
  });
});
