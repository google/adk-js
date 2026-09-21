/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {z} from 'zod';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
  ServiceAccountCredential,
} from '../../../auth/auth_credential.js';
import {
  AuthScheme,
  OpenIdConnectWithConfig,
} from '../../../auth/auth_schemes.js';
import {camelCaseKeys} from '../../../utils/case_utils.js';
import {ApiParameter} from '../openapi_spec_parser/operation_parser.js';

/**
 * Prefix that marks a tool parameter as auth-injected rather than
 * model-supplied.
 */
export const INTERNAL_AUTH_PREFIX = '_auth_prefix_vaf_';

/** Locations an OpenAPI API key may travel in. */
const API_KEY_LOCATIONS = ['header', 'query', 'cookie'] as const;

/** Deadline for the OpenID Connect discovery request, in milliseconds. */
const OPENID_FETCH_TIMEOUT_MS = 10_000;

/** Credential fields `openidDictToSchemeCredential` cannot work without. */
const REQUIRED_CREDENTIAL_FIELDS = ['client_id', 'client_secret'];

const scopesSchema = z.record(z.string(), z.string()).default({});

const OAuthFlowsSchema = z.looseObject({
  implicit: z
    .looseObject({
      authorizationUrl: z.string(),
      refreshUrl: z.string().optional(),
      scopes: scopesSchema,
    })
    .optional(),
  password: z
    .looseObject({
      tokenUrl: z.string(),
      refreshUrl: z.string().optional(),
      scopes: scopesSchema,
    })
    .optional(),
  clientCredentials: z
    .looseObject({
      tokenUrl: z.string(),
      refreshUrl: z.string().optional(),
      scopes: scopesSchema,
    })
    .optional(),
  authorizationCode: z
    .looseObject({
      authorizationUrl: z.string(),
      tokenUrl: z.string(),
      refreshUrl: z.string().optional(),
      scopes: scopesSchema,
    })
    .optional(),
});

const ApiKeySchemeSchema = z.looseObject({
  type: z.literal('apiKey'),
  description: z.string().optional(),
  name: z.string(),
  in: z.enum(API_KEY_LOCATIONS),
});

const HttpSchemeSchema = z.looseObject({
  type: z.literal('http'),
  description: z.string().optional(),
  scheme: z.string(),
  bearerFormat: z.string().optional(),
});

const Oauth2SchemeSchema = z.looseObject({
  type: z.literal('oauth2'),
  description: z.string().optional(),
  flows: OAuthFlowsSchema,
});

const OpenIdConnectSchemeSchema = z.looseObject({
  type: z.literal('openIdConnect'),
  description: z.string().optional(),
  openIdConnectUrl: z.string(),
});

/**
 * Validates a discovery document that has already been normalized to camelCase
 * keys. Unknown keys survive, because a provider document carries far more
 * than the fields `OpenIdConnectWithConfig` names.
 */
const OpenIdConnectConfigSchema = z.looseObject({
  type: z.literal('openIdConnect').default('openIdConnect'),
  description: z.string().optional(),
  openIdConnectUrl: z.string().default(''),
  authorizationEndpoint: z.string(),
  tokenEndpoint: z.string(),
  userinfoEndpoint: z.string().optional(),
  revocationEndpoint: z.string().optional(),
  tokenEndpointAuthMethodsSupported: z.array(z.string()).optional(),
  grantTypesSupported: z.array(z.string()).optional(),
  scopes: z.array(z.string()).optional(),
});

const JsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * Applies the given credential to the request headers and URL.
 *
 * An HTTP credential that carries no usable token throws, so the caller never
 * sends an unauthenticated request in place of an authenticated one.
 *
 * @param url The target URL.
 * @param headers The request headers.
 * @param credential The auth credential.
 * @param authScheme The auth scheme from OpenAPI spec.
 * @returns The updated URL (if modified by query params).
 * @throws {Error} If an HTTP credential holds basic credentials, or holds no
 *   credentials at all.
 */
export function applyCredential(
  url: string,
  headers: Record<string, string>,
  credential?: AuthCredential,
  authScheme?: OpenAPIV3.SecuritySchemeObject,
): string {
  if (!credential) return url;

  if (credential.apiKey) {
    let inLocation: string | undefined;
    let name = 'key';

    if (authScheme && authScheme.type === 'apiKey') {
      const apiKeyScheme = authScheme as OpenAPIV3.ApiKeySecurityScheme;
      inLocation = apiKeyScheme.in;
      name = apiKeyScheme.name;
    }

    if (inLocation === 'header') {
      headers[name] = credential.apiKey;
    } else if (inLocation === 'query') {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${name}=${encodeURIComponent(credential.apiKey)}`;
    } else {
      // Default to header Authorization if not specified or unknown location
      headers['Authorization'] = credential.apiKey;
    }
  } else if (
    credential.authType === AuthCredentialTypes.HTTP ||
    credential.http
  ) {
    const httpCredentials = credential.http?.credentials;
    if (httpCredentials?.token) {
      // The 'Bearer' prefix is hardcoded, and http.scheme is ignored, to match
      // adk-python's credential_to_param. Every exchanger in this repo mints
      // scheme 'bearer', and any other scheme arrives without a token and
      // throws below, so no mislabelled header reaches the wire.
      headers['Authorization'] = `Bearer ${httpCredentials.token}`;
    } else if (httpCredentials?.username || httpCredentials?.password) {
      throw new Error('Basic Authentication is not supported.');
    } else {
      throw new Error('Invalid HTTP auth credentials');
    }
  }

  return url;
}

/**
 * Helper to create a simple API Key auth scheme.
 */
export function createApiKeyScheme(
  name: string,
  inLocation: 'header' | 'query' | 'cookie',
): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'apiKey',
    name,
    in: inLocation,
  };
}

/**
 * Helper to create a simple Bearer Token auth scheme.
 */
export function createBearerScheme(): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'http',
    scheme: 'bearer',
  };
}

/** Narrows an OpenAPI `in` value to the locations an API key may travel in. */
function isApiKeyLocation(
  value: unknown,
): value is (typeof API_KEY_LOCATIONS)[number] {
  return API_KEY_LOCATIONS.some((location) => location === value);
}

/**
 * Builds the bearer-token scheme every token-shaped credential in this module
 * pairs with. A fresh object each call, so a caller may edit its own copy.
 */
function bearerJwtScheme(): OpenAPIV3.HttpSecurityScheme {
  return {type: 'http', scheme: 'bearer', bearerFormat: 'JWT'};
}

/** Builds the synthesized `Authorization: Bearer …` parameter and its value. */
function bearerTokenParam(
  authScheme: AuthScheme,
  token: string,
): [ApiParameter, Record<string, string>] {
  const param: ApiParameter = {
    originalName: 'Authorization',
    paramLocation: 'header',
    paramSchema: {type: 'string'},
    description: authScheme.description ?? 'Bearer token',
    name: `${INTERNAL_AUTH_PREFIX}Authorization`,
    required: true,
  };
  return [param, {[param.name]: `Bearer ${token}`}];
}

/**
 * Creates an AuthScheme and AuthCredential for an API key or a bearer token.
 *
 * @example
 * // API key in a header.
 * const [scheme, credential] = tokenToSchemeCredential(
 *   'apikey', 'header', 'X-API-Key', 'your_api_key_value');
 *
 * @example
 * // OAuth2 bearer token in the Authorization header.
 * const [scheme, credential] = tokenToSchemeCredential(
 *   'oauth2Token', 'header', 'Authorization', 'your_bearer_token_value');
 *
 * @param tokenType `'apikey'` or `'oauth2Token'`.
 * @param location Where the API key travels. Ignored for `'oauth2Token'`,
 *   because a bearer token always travels in the Authorization header.
 * @param name The name of the header, query parameter, or cookie.
 * @param credentialValue The API key or token value. Omit it to build the
 *   scheme alone.
 * @returns A `[scheme, credential]` pair. The credential is `undefined` when
 *   `credentialValue` is omitted.
 * @throws Error For an unsupported token type or API key location.
 */
export function tokenToSchemeCredential(
  tokenType: 'apikey' | 'oauth2Token',
  location?: 'header' | 'query' | 'cookie',
  name?: string,
  credentialValue?: string,
): [AuthScheme, AuthCredential | undefined] {
  if (tokenType === 'apikey') {
    if (!isApiKeyLocation(location)) {
      throw new Error(`Invalid location for apiKey: ${location}`);
    }
    const authScheme: OpenAPIV3.ApiKeySecurityScheme = {
      type: 'apiKey',
      in: location,
      name: name ?? '',
    };
    const authCredential: AuthCredential | undefined = credentialValue
      ? {authType: AuthCredentialTypes.API_KEY, apiKey: credentialValue}
      : undefined;
    return [authScheme, authCredential];
  }

  if (tokenType === 'oauth2Token') {
    const authCredential: AuthCredential | undefined = credentialValue
      ? {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: credentialValue}},
        }
      : undefined;
    return [bearerJwtScheme(), authCredential];
  }

  // Unreachable from a typed caller; the guard serves JavaScript callers. The
  // reference interpolates the builtin `type` here and prints `<class 'type'>`;
  // the port interpolates the argument, which is what the message promises.
  throw new Error(`Invalid security scheme type: ${tokenType}`);
}

/**
 * Creates a bearer scheme and a service-account credential from a raw Google
 * service-account JSON object.
 *
 * @param config The parsed service-account key file.
 * @param scopes The scopes to request.
 * @returns A `[scheme, credential]` pair.
 */
export function serviceAccountDictToSchemeCredential(
  config: Record<string, unknown>,
  scopes: string[],
): [AuthScheme, AuthCredential] {
  const authCredential: AuthCredential = {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: {
      // The reference calls `ServiceAccountCredential.model_construct`, which
      // skips validation on purpose, so the port does not validate either.
      serviceAccountCredential: camelCaseKeys(
        config,
      ) as ServiceAccountCredential,
      scopes,
    },
  };
  return [bearerJwtScheme(), authCredential];
}

/**
 * Creates a bearer scheme and a service-account credential from an already
 * built `ServiceAccount`.
 *
 * @param config The service-account configuration.
 * @returns A `[scheme, credential]` pair.
 */
export function serviceAccountSchemeCredential(
  config: ServiceAccount,
): [AuthScheme, AuthCredential] {
  const authCredential: AuthCredential = {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: config,
  };
  return [bearerJwtScheme(), authCredential];
}

/**
 * Builds an OpenID Connect scheme and credential from a configuration object
 * and a client-secret object.
 *
 * @param configDict An OpenID Connect configuration. Snake_case keys, as a
 *   discovery document delivers them, are accepted and normalized.
 * @param scopes The scopes to request.
 * @param credentialDict The Google OAuth client secret. Its keys stay
 *   snake_case, because it is an on-disk wire format. A `{web: {…}}` or
 *   `{installed: {…}}` wrapper is unwrapped.
 * @returns A `[scheme, credential]` pair.
 * @throws Error When the configuration or the client secret is incomplete.
 */
export function openidDictToSchemeCredential(
  configDict: Record<string, unknown>,
  scopes: string[],
  credentialDict: Record<string, unknown>,
): [OpenIdConnectWithConfig, AuthCredential] {
  const parsedConfig = OpenIdConnectConfigSchema.safeParse(
    camelCaseKeys(configDict),
  );
  if (!parsedConfig.success) {
    throw new Error(
      `Invalid OpenID Connect configuration: ${z.prettifyError(parsedConfig.error)}`,
    );
  }
  const openidScheme: OpenIdConnectWithConfig = {...parsedConfig.data, scopes};

  const values = Object.values(credentialDict);
  if (values.length === 1) {
    const wrapped = JsonObjectSchema.safeParse(values[0]);
    if (
      wrapped.success &&
      'client_id' in wrapped.data &&
      'client_secret' in wrapped.data
    ) {
      credentialDict = wrapped.data;
    }
  }

  const missingFields = REQUIRED_CREDENTIAL_FIELDS.filter(
    (field) => !(field in credentialDict),
  );
  if (missingFields.length > 0) {
    throw new Error(
      `Missing required fields in credential_dict: ${missingFields.join(', ')}`,
    );
  }

  const authCredential: AuthCredential = {
    authType: AuthCredentialTypes.OPEN_ID_CONNECT,
    oauth2: {
      clientId: String(credentialDict['client_id']),
      clientSecret: String(credentialDict['client_secret']),
      redirectUri:
        'redirect_uri' in credentialDict
          ? String(credentialDict['redirect_uri'])
          : undefined,
    },
  };

  return [openidScheme, authCredential];
}

/**
 * Fetches an OpenID Connect discovery document and pairs it with a client
 * secret.
 *
 * The URL is used as given. A caller that accepts it from an untrusted source
 * has to validate it first, because this function performs the request.
 *
 * @param openidUrl The OpenID Connect discovery URL.
 * @param scopes The scopes to request.
 * @param credentialDict The Google OAuth client secret, keyed snake_case.
 * @returns A `[scheme, credential]` pair.
 * @throws Error When the request fails, the body is not a JSON object, or the
 *   configuration is incomplete.
 */
export async function openidUrlToSchemeCredential(
  openidUrl: string,
  scopes: string[],
  credentialDict: Record<string, unknown>,
): Promise<[OpenIdConnectWithConfig, AuthCredential]> {
  let response: Response;
  try {
    response = await fetch(openidUrl, {
      signal: AbortSignal.timeout(OPENID_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`responded with status ${response.status}`);
    }
  } catch (e: unknown) {
    throw new Error(
      `Failed to fetch OpenID configuration from ${openidUrl}: ${String(e)}`,
    );
  }

  let configDict: Record<string, unknown>;
  try {
    configDict = JsonObjectSchema.parse(await response.json());
  } catch (e: unknown) {
    throw new Error(
      `Invalid JSON response from OpenID configuration endpoint ${openidUrl}: ${String(e)}`,
    );
  }

  return openidDictToSchemeCredential(
    {...configDict, openIdConnectUrl: openidUrl},
    scopes,
    credentialDict,
  );
}

/**
 * Converts a scheme and credential into the tool parameter that carries the
 * credential, plus the value to send for it.
 *
 * Service-account, OAuth2, and OpenID Connect credentials reach this function
 * already exchanged for a bearer token, so they take the HTTP branch.
 *
 * @param authScheme The auth scheme.
 * @param authCredential The auth credential.
 * @returns A `[parameter, values]` pair, both `undefined` when the credential
 *   carries nothing to send.
 * @throws Error For basic authentication, which is not supported, and for a
 *   scheme and credential combination that cannot be expressed as a parameter.
 */
export function credentialToParam(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): [ApiParameter | undefined, Record<string, string> | undefined] {
  if (!authCredential) {
    return [undefined, undefined];
  }

  if (authScheme.type === 'apiKey' && authCredential.apiKey) {
    if (!isApiKeyLocation(authScheme.in)) {
      throw new Error(`Invalid API Key location: ${authScheme.in}`);
    }
    const paramName = authScheme.name || '';
    const param: ApiParameter = {
      originalName: paramName,
      paramLocation: authScheme.in,
      paramSchema: {type: 'string'},
      description: authScheme.description ?? '',
      name: INTERNAL_AUTH_PREFIX + paramName,
      required: true,
    };
    return [param, {[param.name]: authCredential.apiKey}];
  }

  if (authCredential.authType === AuthCredentialTypes.HTTP) {
    const credentials = authCredential.http?.credentials;
    if (credentials?.token) {
      return bearerTokenParam(authScheme, credentials.token);
    }
    if (credentials?.username || credentials?.password) {
      throw new Error('Basic Authentication is not supported.');
    }
    throw new Error('Invalid HTTP auth credentials');
  }

  if (authScheme.type === 'oauth2' || authScheme.type === 'openIdConnect') {
    const token = authCredential.http?.credentials?.token;
    return token ? bearerTokenParam(authScheme, token) : [undefined, undefined];
  }

  throw new Error('Invalid security scheme and credential combination');
}

/** Validates `data` against `schema`, reporting failures the same way. */
function parseSecurityScheme<S extends z.ZodType>(
  schema: S,
  data: Record<string, unknown>,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Invalid security scheme data: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Converts a security scheme object out of an OpenAPI document into an
 * `AuthScheme`.
 *
 * @example
 * const scheme = dictToAuthScheme({
 *   type: 'apiKey',
 *   in: 'header',
 *   name: 'X-API-Key',
 * });
 *
 * @param data The security scheme object.
 * @returns The validated auth scheme.
 * @throws Error When `type` is missing or unrecognised, or the rest of the
 *   object does not match the shape that type requires.
 */
export function dictToAuthScheme(data: Record<string, unknown>): AuthScheme {
  if (!('type' in data)) {
    throw new Error("Missing 'type' field in security scheme dictionary.");
  }

  const securityType = data['type'];
  switch (securityType) {
    case 'apiKey':
      return parseSecurityScheme(ApiKeySchemeSchema, data);
    case 'http':
      return parseSecurityScheme(HttpSchemeSchema, data);
    case 'oauth2':
      return parseSecurityScheme(Oauth2SchemeSchema, data);
    case 'openIdConnect':
      return parseSecurityScheme(OpenIdConnectSchemeSchema, data);
    default:
      throw new Error(`Invalid security scheme type: ${securityType}`);
  }
}
