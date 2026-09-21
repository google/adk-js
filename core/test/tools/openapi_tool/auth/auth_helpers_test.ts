/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `auth_helpers` suite. The `describe('auth_helpers')` block is ported from
 * google/adk-python at tag v0.1.0,
 * `src/google/adk/tests/unittests/tools/openapi_tool/auth/test_auth_helper.py`,
 * and each `it()` in it keeps the Python test name so the two suites stay
 * greppable against each other. The blocks after it cover the error and edge
 * paths the reference suite does not reach.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  credentialToParam,
  dictToAuthScheme,
  INTERNAL_AUTH_PREFIX,
  openidDictToSchemeCredential,
  openidUrlToSchemeCredential,
  ServiceAccount,
  serviceAccountDictToSchemeCredential,
  serviceAccountSchemeCredential,
  tokenToSchemeCredential,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const BEARER_JWT_SCHEME = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
};

const OPENID_CREDENTIAL_DICT = {
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

describe('auth_helpers', () => {
  it('test_token_to_scheme_credential_api_key_header', () => {
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

  it('test_token_to_scheme_credential_api_key_query', () => {
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

  it('test_token_to_scheme_credential_api_key_cookie', () => {
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

  it('test_token_to_scheme_credential_api_key_no_credential', () => {
    const [scheme, credential] = tokenToSchemeCredential(
      'apikey',
      'cookie',
      'session_id',
    );

    expect(scheme).toEqual({type: 'apiKey', in: 'cookie', name: 'session_id'});
    expect(credential).toBeUndefined();
  });

  it('test_token_to_scheme_credential_oauth2_token', () => {
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

  it('test_token_to_scheme_credential_oauth2_no_credential', () => {
    const [scheme, credential] = tokenToSchemeCredential(
      'oauth2Token',
      'header',
      'Authorization',
    );

    expect(scheme).toEqual(BEARER_JWT_SCHEME);
    expect(credential).toBeUndefined();
  });

  it('test_service_account_dict_to_scheme_credential', () => {
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

    const [scheme, credential] = serviceAccountDictToSchemeCredential(
      config,
      SCOPES,
    );

    expect(scheme).toEqual(BEARER_JWT_SCHEME);
    expect(credential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
    expect(credential.serviceAccount?.scopes).toEqual(SCOPES);
    // Divergence 7: adk-js `ServiceAccountCredential` fields are camelCase.
    expect(credential.serviceAccount?.serviceAccountCredential?.projectId).toBe(
      'project_id',
    );
  });

  it('test_service_account_scheme_credential', () => {
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

  it('test_openid_dict_to_scheme_credential', () => {
    const configDict = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
      openIdConnectUrl: 'openid_url',
    };

    const [scheme, credential] = openidDictToSchemeCredential(
      configDict,
      SCOPES,
      OPENID_CREDENTIAL_DICT,
    );

    // Divergence 7: adk-js `OpenIdConnectWithConfig` fields are camelCase.
    expect(scheme.authorizationEndpoint).toBe('auth_url');
    expect(scheme.tokenEndpoint).toBe('token_url');
    expect(scheme.scopes).toEqual(SCOPES);
    expect(credential.authType).toBe(AuthCredentialTypes.OPEN_ID_CONNECT);
    expect(credential.oauth2?.clientId).toBe('client_id');
    expect(credential.oauth2?.clientSecret).toBe('client_secret');
    expect(credential.oauth2?.redirectUri).toBe('redirect_uri');
  });

  it('test_openid_dict_to_scheme_credential_no_openid_url', () => {
    const configDict = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
    };

    const [scheme] = openidDictToSchemeCredential(
      configDict,
      SCOPES,
      OPENID_CREDENTIAL_DICT,
    );

    expect(scheme.openIdConnectUrl).toBe('');
  });

  it('test_openid_dict_to_scheme_credential_google_oauth_credential', () => {
    const configDict = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
      openIdConnectUrl: 'openid_url',
    };
    const credentialDict = {web: OPENID_CREDENTIAL_DICT};

    const [scheme, credential] = openidDictToSchemeCredential(
      configDict,
      SCOPES,
      credentialDict,
    );

    expect(scheme.type).toBe('openIdConnect');
    expect(credential.authType).toBe(AuthCredentialTypes.OPEN_ID_CONNECT);
    expect(credential.oauth2?.clientId).toBe('client_id');
    expect(credential.oauth2?.clientSecret).toBe('client_secret');
    expect(credential.oauth2?.redirectUri).toBe('redirect_uri');
  });

  it('test_openid_dict_to_scheme_credential_invalid_config', () => {
    expect(() =>
      openidDictToSchemeCredential({invalid_field: 'value'}, SCOPES, {
        client_id: 'client_id',
        client_secret: 'client_secret',
      }),
    ).toThrow(/Invalid OpenID Connect configuration/);
  });

  it('test_openid_dict_to_scheme_credential_missing_credential_fields', () => {
    const configDict = {
      authorization_endpoint: 'auth_url',
      token_endpoint: 'token_url',
    };

    expect(() =>
      openidDictToSchemeCredential(configDict, SCOPES, {
        client_id: 'client_id',
      }),
    ).toThrow('Missing required fields in credential_dict: client_secret');
  });

  describe('openidUrlToSchemeCredential', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('test_openid_url_to_scheme_credential', async () => {
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
        OPENID_CREDENTIAL_DICT,
      );

      expect(scheme.authorizationEndpoint).toBe('auth_url');
      expect(scheme.tokenEndpoint).toBe('token_url');
      expect(scheme.scopes).toEqual(SCOPES);
      expect(credential.authType).toBe(AuthCredentialTypes.OPEN_ID_CONNECT);
      expect(credential.oauth2?.clientId).toBe('client_id');
      expect(credential.oauth2?.clientSecret).toBe('client_secret');
      expect(credential.oauth2?.redirectUri).toBe('redirect_uri');
      // Adapted from `mock_get.assert_called_once_with("openid_url",
      // timeout=10)`: fetch carries its deadline on an AbortSignal instead.
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('openid_url');
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeDefined();
    });

    it('test_openid_url_to_scheme_credential_no_openid_url', async () => {
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
        OPENID_CREDENTIAL_DICT,
      );

      expect(scheme.openIdConnectUrl).toBe('openid_url');
    });

    it('test_openid_url_to_scheme_credential_request_exception', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Test Error'));

      await expect(
        openidUrlToSchemeCredential('openid_url', [], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).rejects.toThrow('Failed to fetch OpenID configuration from openid_url');
    });

    it('test_openid_url_to_scheme_credential_invalid_json', async () => {
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

  it('test_credential_to_param_api_key_header', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('X-API-Key');
    expect(param?.paramLocation).toBe('header');
    expect(kwargs).toEqual({[`${INTERNAL_AUTH_PREFIX}X-API-Key`]: 'test_key'});
  });

  it('test_credential_to_param_api_key_query', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'query',
      name: 'api_key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('api_key');
    expect(param?.paramLocation).toBe('query');
    expect(kwargs).toEqual({[`${INTERNAL_AUTH_PREFIX}api_key`]: 'test_key'});
  });

  it('test_credential_to_param_api_key_cookie', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'cookie',
      name: 'session_id',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('session_id');
    expect(param?.paramLocation).toBe('cookie');
    expect(kwargs).toEqual({[`${INTERNAL_AUTH_PREFIX}session_id`]: 'test_key'});
  });

  it('test_credential_to_param_http_bearer', () => {
    const authScheme: AuthScheme = {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    };

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('Authorization');
    expect(param?.paramLocation).toBe('header');
    expect(kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('test_credential_to_param_http_basic_not_supported', () => {
    const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'basic',
        credentials: {username: 'user', password: 'password'},
      },
    };

    // Divergence 3: the reference raises NotImplementedError; TypeScript has
    // no equivalent, so the message is what carries over.
    expect(() => credentialToParam(authScheme, authCredential)).toThrow(
      'Basic Authentication is not supported.',
    );
  });

  it('test_credential_to_param_http_invalid_credentials_no_http', () => {
    const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
    };

    expect(() => credentialToParam(authScheme, authCredential)).toThrow(
      'Invalid HTTP auth credentials',
    );
  });

  it('test_credential_to_param_oauth2', () => {
    const authScheme: AuthScheme = {type: 'oauth2', flows: {}};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    };

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('Authorization');
    expect(param?.paramLocation).toBe('header');
    expect(kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('test_credential_to_param_openid_connect', () => {
    const authScheme: AuthScheme = {
      type: 'openIdConnect',
      openIdConnectUrl: 'openid_url',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    };

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('Authorization');
    expect(param?.paramLocation).toBe('header');
    expect(kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('test_credential_to_param_openid_no_credential', () => {
    const authScheme: AuthScheme = {
      type: 'openIdConnect',
      openIdConnectUrl: 'openid_url',
    };

    const [param, kwargs] = credentialToParam(authScheme, undefined);

    expect(param).toBeUndefined();
    expect(kwargs).toBeUndefined();
  });

  it('test_credential_to_param_oauth2_no_credential', () => {
    const authScheme: AuthScheme = {type: 'oauth2', flows: {}};

    const [param, kwargs] = credentialToParam(authScheme, undefined);

    expect(param).toBeUndefined();
    expect(kwargs).toBeUndefined();
  });

  it('test_dict_to_auth_scheme_api_key', () => {
    const scheme = dictToAuthScheme({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });

    // Divergence 2: adk-js schemes are structural, so the test asserts the
    // shape where the reference asserts the pydantic class.
    expect(scheme).toEqual({type: 'apiKey', in: 'header', name: 'X-API-Key'});
  });

  it('test_dict_to_auth_scheme_http_bearer', () => {
    const scheme = dictToAuthScheme({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });

    expect(scheme).toEqual(BEARER_JWT_SCHEME);
  });

  it('test_dict_to_auth_scheme_http_base', () => {
    const scheme = dictToAuthScheme({type: 'http', scheme: 'basic'});

    expect(scheme).toEqual({type: 'http', scheme: 'basic'});
  });

  it('test_dict_to_auth_scheme_oauth2', () => {
    const scheme = dictToAuthScheme({
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

  it('test_dict_to_auth_scheme_openid_connect', () => {
    const scheme = dictToAuthScheme({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
    });

    expect(scheme).toEqual({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
    });
  });

  it('test_dict_to_auth_scheme_missing_type', () => {
    expect(() => dictToAuthScheme({in: 'header', name: 'X-API-Key'})).toThrow(
      "Missing 'type' field in security scheme dictionary.",
    );
  });

  it('test_dict_to_auth_scheme_invalid_type', () => {
    expect(() =>
      dictToAuthScheme({type: 'invalid', in: 'header', name: 'X-API-Key'}),
    ).toThrow('Invalid security scheme type: invalid');
  });

  it('test_dict_to_auth_scheme_invalid_data', () => {
    expect(() => dictToAuthScheme({type: 'apiKey', in: 'header'})).toThrow(
      /Invalid security scheme data/,
    );
  });
});

const CREDENTIAL_DICT = {
  client_id: 'client_id',
  client_secret: 'client_secret',
};

describe('INTERNAL_AUTH_PREFIX', () => {
  it('matches the value adk-python uses', () => {
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

describe('openidDictToSchemeCredential', () => {
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

    const [fromSnakeCase] = openidDictToSchemeCredential(
      snakeCase,
      ['openid'],
      CREDENTIAL_DICT,
    );
    const [fromCamelCase] = openidDictToSchemeCredential(
      camelCase,
      ['openid'],
      CREDENTIAL_DICT,
    );

    expect(fromSnakeCase).toEqual(fromCamelCase);
    expect(fromSnakeCase.userinfoEndpoint).toBe('userinfo_url');
    expect(fromSnakeCase.tokenEndpointAuthMethodsSupported).toEqual([
      'client_secret_post',
    ]);
  });

  it('leaves redirectUri undefined when the credential omits it', () => {
    const [, credential] = openidDictToSchemeCredential(
      {authorization_endpoint: 'auth_url', token_endpoint: 'token_url'},
      [],
      CREDENTIAL_DICT,
    );

    expect(credential.oauth2?.redirectUri).toBeUndefined();
  });

  it('keeps a single-valued credential that is not a client-secret wrapper', () => {
    expect(() =>
      openidDictToSchemeCredential(
        {authorization_endpoint: 'auth_url', token_endpoint: 'token_url'},
        [],
        {installed: {client_id: 'client_id'}},
      ),
    ).toThrow(
      'Missing required fields in credential_dict: client_id, client_secret',
    );
  });

  it('keeps a single-valued credential whose value is not an object', () => {
    expect(() =>
      openidDictToSchemeCredential(
        {authorization_endpoint: 'auth_url', token_endpoint: 'token_url'},
        [],
        {web: 'not an object'},
      ),
    ).toThrow(
      'Missing required fields in credential_dict: client_id, client_secret',
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
      openidUrlToSchemeCredential('openid_url', [], CREDENTIAL_DICT),
    ).rejects.toThrow(
      'Failed to fetch OpenID configuration from openid_url: Error: responded with status 500',
    );
  });

  it('rejects a JSON body that is not an object', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('[1, 2]', {status: 200}));

    await expect(
      openidUrlToSchemeCredential('openid_url', [], CREDENTIAL_DICT),
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

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('');
    expect(kwargs).toEqual({[INTERNAL_AUTH_PREFIX]: 'test_key'});
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

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param?.originalName).toBe('Authorization');
    expect(kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('returns nothing for an unexchanged oauth2 credential', () => {
    const authScheme: AuthScheme = {type: 'oauth2', flows: {}};
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client_id'},
    };

    const [param, kwargs] = credentialToParam(authScheme, authCredential);

    expect(param).toBeUndefined();
    expect(kwargs).toBeUndefined();
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

describe('dictToAuthScheme', () => {
  it('rejects oauth2 with no flows', () => {
    expect(() => dictToAuthScheme({type: 'oauth2'})).toThrow(
      /Invalid security scheme data/,
    );
  });

  it('rejects openIdConnect with no openIdConnectUrl', () => {
    expect(() => dictToAuthScheme({type: 'openIdConnect'})).toThrow(
      /Invalid security scheme data/,
    );
  });

  it('rejects an apiKey location outside header, query and cookie', () => {
    expect(() =>
      dictToAuthScheme({type: 'apiKey', in: 'body', name: 'X-API-Key'}),
    ).toThrow(/Invalid security scheme data/);
  });

  it('rejects a bearer scheme whose bearerFormat is not a string', () => {
    expect(() =>
      dictToAuthScheme({type: 'http', scheme: 'bearer', bearerFormat: 7}),
    ).toThrow(/Invalid security scheme data/);
  });

  it('rejects an http scheme with no scheme field', () => {
    expect(() => dictToAuthScheme({type: 'http'})).toThrow(
      /Invalid security scheme data/,
    );
  });

  it('keeps unknown keys on a validated scheme', () => {
    const scheme = dictToAuthScheme({
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
