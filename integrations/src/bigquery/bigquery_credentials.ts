/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type AuthConfig,
  AuthCredentialTypes,
  type Context,
  logger,
} from '@google/adk';

/**
 * State key used to cache serialized BigQuery OAuth credentials in session state.
 */
export const BIGQUERY_TOKEN_CACHE_KEY = 'bigquery_token_cache';

/**
 * Default OAuth2 scope for BigQuery API requests.
 */
export const BIGQUERY_DEFAULT_SCOPE: readonly string[] = Object.freeze([
  'https://www.googleapis.com/auth/bigquery',
]);

/**
 * OAuth2 scopes requested by default for BigQuery tools.
 */
export const BIGQUERY_SCOPES: readonly string[] = Object.freeze([
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/dataplex.read-write',
]);

const GOOGLE_OAUTH_AUTHORIZATION_URL =
  'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Clock-skew and in-flight leeway subtracted from token expiry checks, matching
 * `@google/adk`'s `isTokenExpired` default (60 seconds).
 */
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;

/**
 * Structural interface for an authentication client (such as a
 * `google-auth-library` `AuthClient`, `OAuth2Client`, `JWT`, or `GoogleAuth`)
 * that supplies request headers on demand.
 */
export interface BigQueryAuthClient {
  /**
   * Returns HTTP request headers for authenticating a BigQuery API request.
   */
  getRequestHeaders(
    url?: string | URL,
  ): Promise<Headers | Record<string, string>> | Record<string, string>;

  /**
   * Optional method returning an access token for the current credentials.
   */
  getAccessToken?: () => Promise<
    {token?: string | null} | string | null | undefined
  >;
}

/**
 * Type guard checking whether a credential object implements
 * {@link BigQueryAuthClient}.
 */
export function isBigQueryAuthClient(
  credentials: unknown,
): credentials is BigQueryAuthClient {
  return (
    typeof credentials === 'object' &&
    credentials !== null &&
    'getRequestHeaders' in credentials &&
    typeof (credentials as BigQueryAuthClient).getRequestHeaders === 'function'
  );
}

/**
 * Google OAuth2 credentials used to authenticate BigQuery requests.
 */
export interface GoogleOAuthCredentials {
  /**
   * OAuth2 access token.
   */
  token?: string;

  /**
   * OAuth2 refresh token used to obtain a new access token when expired.
   */
  refreshToken?: string;

  /**
   * Token endpoint URI used to refresh tokens.
   */
  tokenUri?: string;

  /**
   * OAuth2 client ID associated with the credentials.
   */
  clientId?: string;

  /**
   * OAuth2 client secret associated with the credentials.
   */
  clientSecret?: string;

  /**
   * OAuth2 scopes granted to or requested by the credentials.
   */
  scopes?: string[];

  /**
   * ISO-8601 timestamp string indicating when the access token expires.
   */
  expiry?: string;

  /**
   * Whether the credentials are currently valid and non-expired.
   */
  valid?: boolean;

  /**
   * Whether the access token has expired.
   */
  expired?: boolean;

  /**
   * Refreshes the access token using the refresh token.
   */
  refresh?: () => void | Promise<void>;

  /**
   * Serializes the credentials to a JSON string for the session cache.
   */
  toJson?: () => string;

  /** Disallows `google-auth-library` `Credentials` keys on OAuth credentials. */
  access_token?: never;
  refresh_token?: never;
  expiry_date?: never;
  token_type?: never;
  id_token?: never;
  scope?: never;
  /** Disallows {@link BigQueryAuthClient} keys on OAuth credentials. */
  getRequestHeaders?: never;
  getAccessToken?: never;
}

/**
 * Structural interface matching `google-auth-library`'s `Credentials` token
 * payload. Disallows {@link GoogleOAuthCredentials} and
 * {@link BigQueryAuthClient} keys so {@link BigQueryCredentials} union branches
 * remain mutually disjoint while accepting `google-auth-library`'s `Credentials`.
 */
export interface GoogleAuthLibraryCredentials {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
  id_token?: string | null;
  scope?: string;
  token?: never;
  refreshToken?: never;
  tokenUri?: never;
  clientId?: never;
  clientSecret?: never;
  scopes?: never;
  expiry?: never;
  valid?: never;
  expired?: never;
  refresh?: never;
  toJson?: never;
  getRequestHeaders?: never;
  getAccessToken?: never;
}

/**
 * Credentials accepted by BigQuery tools and client helpers: an OAuth2
 * credential object ({@link GoogleOAuthCredentials}), a `google-auth-library`
 * token payload ({@link GoogleAuthLibraryCredentials}), or an auth client that
 * produces request headers ({@link BigQueryAuthClient}).
 */
export type BigQueryCredentials =
  GoogleOAuthCredentials | GoogleAuthLibraryCredentials | BigQueryAuthClient;

function isGoogleAuthLibraryCredentials(
  credentials: unknown,
): credentials is GoogleAuthLibraryCredentials {
  if (typeof credentials !== 'object' || credentials === null) {
    return false;
  }
  if (
    'token' in credentials ||
    'refreshToken' in credentials ||
    'valid' in credentials ||
    'expired' in credentials ||
    'refresh' in credentials ||
    'toJson' in credentials
  ) {
    return false;
  }
  return (
    'access_token' in credentials ||
    'refresh_token' in credentials ||
    'expiry_date' in credentials ||
    'token_type' in credentials ||
    'id_token' in credentials ||
    'scope' in credentials
  );
}

/**
 * Normalizes a {@link BigQueryCredentials} value into either a
 * {@link BigQueryAuthClient} or a {@link GoogleOAuthCredentials} object.
 * Existing {@link GoogleOAuthCredentials} and {@link BigQueryAuthClient}
 * instances are returned as-is; `google-auth-library` `Credentials` objects are
 * converted into {@link BigQueryOAuthCredentials}.
 */
export function normalizeBigQueryCredentials(
  credentials: BigQueryCredentials,
  options?: {clientId?: string; clientSecret?: string},
): GoogleOAuthCredentials | BigQueryAuthClient {
  if (isBigQueryAuthClient(credentials)) {
    return credentials;
  }
  if (isGoogleAuthLibraryCredentials(credentials)) {
    const token =
      typeof credentials.access_token === 'string' &&
      credentials.access_token.length > 0
        ? credentials.access_token
        : undefined;
    const refreshToken =
      typeof credentials.refresh_token === 'string' &&
      credentials.refresh_token.length > 0
        ? credentials.refresh_token
        : undefined;
    const expiresAt =
      typeof credentials.expiry_date === 'number' &&
      Number.isFinite(credentials.expiry_date)
        ? credentials.expiry_date
        : undefined;
    const scopes =
      typeof credentials.scope === 'string' &&
      credentials.scope.trim().length > 0
        ? credentials.scope.trim().split(/\s+/)
        : undefined;
    return new BigQueryOAuthCredentials({
      ...(token !== undefined ? {token} : {}),
      ...(refreshToken !== undefined ? {refreshToken} : {}),
      ...(expiresAt !== undefined ? {expiresAt} : {}),
      ...(scopes !== undefined ? {scopes} : {}),
      ...(options?.clientId !== undefined ? {clientId: options.clientId} : {}),
      ...(options?.clientSecret !== undefined
        ? {clientSecret: options.clientSecret}
        : {}),
    });
  }
  return credentials;
}

/**
 * Serialized form of OAuth2 credentials stored in the session cache. It uses
 * the field names of Google's authorized user JSON format.
 */
interface SerializedOAuthCredentials {
  token?: string;
  refresh_token?: string;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
  expiry?: string;
}

function serializeCredentials(creds: GoogleOAuthCredentials): string {
  if (creds.toJson) {
    return creds.toJson();
  }
  const serialized: SerializedOAuthCredentials = {
    token: creds.token,
    refresh_token: creds.refreshToken,
    token_uri: creds.tokenUri ?? GOOGLE_OAUTH_TOKEN_URL,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scopes: creds.scopes,
    expiry: creds.expiry,
  };
  return JSON.stringify(serialized);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeExpiry(
  expiry?: string | number | Date,
  expiresAt?: number,
): string | undefined {
  if (expiry !== undefined) {
    if (typeof expiry === 'string') {
      const parsed = Date.parse(expiry);
      return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
    }
    if (typeof expiry === 'number' && Number.isFinite(expiry)) {
      return new Date(expiry).toISOString();
    }
    if (expiry instanceof Date && !Number.isNaN(expiry.getTime())) {
      return expiry.toISOString();
    }
    return undefined;
  }
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    return new Date(expiresAt).toISOString();
  }
  return undefined;
}

/**
 * Options for constructing {@link BigQueryOAuthCredentials}.
 */
export interface BigQueryOAuthCredentialsOptions {
  /**
   * OAuth2 access token.
   */
  token?: string;

  /**
   * OAuth2 refresh token.
   */
  refreshToken?: string;

  /**
   * Token endpoint URI. Defaults to `'https://oauth2.googleapis.com/token'`.
   */
  tokenUri?: string;

  /**
   * OAuth2 client ID.
   */
  clientId?: string;

  /**
   * OAuth2 client secret.
   */
  clientSecret?: string;

  /**
   * OAuth2 scopes associated with the credential.
   */
  scopes?: string[];

  /**
   * Access token expiry as an ISO-8601 string, epoch milliseconds, or `Date`.
   */
  expiry?: string | number | Date;

  /**
   * Access token expiry in epoch milliseconds (`OAuth2Auth.expiresAt`).
   */
  expiresAt?: number;

  /**
   * Whether the credential is currently valid.
   */
  valid?: boolean;

  /**
   * Whether the credential is expired.
   */
  expired?: boolean;

  /**
   * Optional custom refresh callback used to obtain a fresh token.
   */
  refreshHandler?: () => Promise<{
    token: string;
    refreshToken?: string;
    expiry?: string | number | Date;
    expiresAt?: number;
    expiresIn?: number;
  }>;
}

/**
 * Concrete OAuth2 credentials implementation for BigQuery tools.
 */
export class BigQueryOAuthCredentials implements GoogleOAuthCredentials {
  token?: string;
  refreshToken?: string;
  tokenUri: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  expiry?: string;
  private explicitExpired?: boolean;
  private explicitValid?: boolean;
  private readonly refreshHandler?: () => Promise<{
    token: string;
    refreshToken?: string;
    expiry?: string | number | Date;
    expiresAt?: number;
    expiresIn?: number;
  }>;

  constructor(options: BigQueryOAuthCredentialsOptions = {}) {
    this.token = options.token;
    this.refreshToken = options.refreshToken;
    this.tokenUri = options.tokenUri ?? GOOGLE_OAUTH_TOKEN_URL;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scopes = options.scopes ? [...options.scopes] : undefined;
    this.expiry = normalizeExpiry(options.expiry, options.expiresAt);
    this.explicitExpired = options.expired;
    this.explicitValid = options.valid;
    this.refreshHandler = options.refreshHandler;
  }

  /**
   * Whether the access token has expired. Computed from {@link expiry} with a
   * 60-second leeway unless explicitly overridden.
   */
  get expired(): boolean {
    if (this.explicitExpired !== undefined) {
      return this.explicitExpired;
    }
    if (this.expiry !== undefined) {
      const expiryMs = Date.parse(this.expiry);
      if (!Number.isNaN(expiryMs)) {
        return expiryMs - TOKEN_EXPIRY_LEEWAY_MS <= Date.now();
      }
    }
    return false;
  }

  set expired(value: boolean) {
    this.explicitExpired = value;
  }

  /**
   * Whether the credentials have a non-empty access token and are not expired.
   */
  get valid(): boolean {
    if (this.explicitValid !== undefined) {
      return this.explicitValid;
    }
    return Boolean(this.token) && !this.expired;
  }

  set valid(value: boolean) {
    this.explicitValid = value;
  }

  /**
   * Refreshes the OAuth2 access token using the configured refresh handler or token endpoint.
   */
  async refresh(): Promise<void> {
    if (this.refreshHandler) {
      const refreshed = await this.refreshHandler();
      this.token = refreshed.token;
      if (refreshed.refreshToken !== undefined) {
        this.refreshToken = refreshed.refreshToken;
      }
      if (refreshed.expiry !== undefined || refreshed.expiresAt !== undefined) {
        this.expiry = normalizeExpiry(refreshed.expiry, refreshed.expiresAt);
      } else if (
        typeof refreshed.expiresIn === 'number' &&
        Number.isFinite(refreshed.expiresIn)
      ) {
        this.expiry = new Date(
          Date.now() + refreshed.expiresIn * 1000,
        ).toISOString();
      } else {
        this.expiry = undefined;
      }
      this.explicitExpired = undefined;
      this.explicitValid = undefined;
      return;
    }

    if (!this.refreshToken) {
      throw new Error('Cannot refresh credentials without a refresh token.');
    }
    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        'Cannot refresh credentials without clientId and clientSecret.',
      );
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const response = await fetch(this.tokenUri, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to refresh OAuth2 token: HTTP ${response.status}.`,
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = optionalString(payload['access_token']);
    if (!accessToken) {
      throw new Error('Token refresh response did not contain access_token.');
    }
    this.token = accessToken;
    const refreshToken = optionalString(payload['refresh_token']);
    if (refreshToken !== undefined) {
      this.refreshToken = refreshToken;
    }
    const expiresIn = optionalNumber(payload['expires_in']);
    const rawExpiry = payload['expiry'];
    const rawExpiresAt = optionalNumber(payload['expires_at']);
    if (expiresIn !== undefined) {
      this.expiry = new Date(Date.now() + expiresIn * 1000).toISOString();
    } else if (typeof rawExpiry === 'string' || typeof rawExpiry === 'number') {
      this.expiry = normalizeExpiry(rawExpiry);
    } else if (rawExpiresAt !== undefined) {
      this.expiry = normalizeExpiry(undefined, rawExpiresAt);
    } else {
      this.expiry = undefined;
    }
    this.explicitExpired = undefined;
    this.explicitValid = undefined;
  }

  /**
   * Serializes the credentials to a JSON string for session caching.
   */
  toJson(): string {
    const serialized: SerializedOAuthCredentials = {
      token: this.token,
      refresh_token: this.refreshToken,
      token_uri: this.tokenUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scopes: this.scopes,
      expiry: this.expiry,
    };
    return JSON.stringify(serialized);
  }
}

/**
 * Configuration options for {@link BigQueryCredentialsConfig}.
 */
export interface BigQueryCredentialsConfigOptions {
  /**
   * Pre-existing Google OAuth2 credentials or `google-auth-library` client.
   * Mutually exclusive with `externalAccessTokenKey` and `scopes`. Also
   * mutually exclusive with `clientId` and `clientSecret`, except when
   * providing a `google-auth-library` {@link GoogleAuthLibraryCredentials}
   * payload that needs `clientId` and `clientSecret` to refresh expired
   * tokens.
   */
  credentials?: BigQueryCredentials;

  /**
   * Session state key holding an external OAuth2 access token. Mutually
   * exclusive with `credentials`, `clientId`, `clientSecret`, and `scopes`.
   */
  externalAccessTokenKey?: string;

  /**
   * OAuth2 client ID used for the interactive OAuth2 authorization code flow.
   */
  clientId?: string;

  /**
   * OAuth2 client secret used for the interactive OAuth2 authorization code flow.
   */
  clientSecret?: string;

  /**
   * OAuth2 scopes to request. Defaults to {@link BIGQUERY_SCOPES} when omitted
   * or empty.
   */
  scopes?: string[];
}

const BIGQUERY_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.bigQueryCredentialsConfig',
);

/**
 * Type guard to check if an object is an instance of {@link BigQueryCredentialsConfig}.
 */
export function isBigQueryCredentialsConfig(
  obj: unknown,
): obj is BigQueryCredentialsConfig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BIGQUERY_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[
      BIGQUERY_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL
    ] === true
  );
}

/**
 * Configuration for Google BigQuery API authentication in {@link BigQueryTool}
 * and {@link BigQueryToolset}.
 */
export class BigQueryCredentialsConfig {
  readonly [BIGQUERY_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL] = true;

  /**
   * Pre-existing credentials when configured.
   */
  credentials?: BigQueryCredentials;

  /**
   * Session state key from which to read an external access token.
   */
  externalAccessTokenKey?: string;

  /**
   * OAuth2 client ID.
   */
  clientId?: string;

  /**
   * OAuth2 client secret.
   */
  clientSecret?: string;

  /**
   * OAuth2 scopes to request or apply.
   */
  scopes: string[];

  /**
   * Session state key used to cache OAuth2 tokens.
   */
  readonly tokenCacheKey: string;

  constructor(options: BigQueryCredentialsConfigOptions = {}) {
    const hasScopes = Boolean(options.scopes?.length);

    if (options.credentials !== undefined) {
      if (isGoogleAuthLibraryCredentials(options.credentials)) {
        if (options.externalAccessTokenKey !== undefined || hasScopes) {
          throw new Error(
            'If credentials are provided, externalAccessTokenKey and scopes must not be provided.',
          );
        }
        if (
          (options.clientId !== undefined) !==
          (options.clientSecret !== undefined)
        ) {
          throw new Error(
            'When providing clientId or clientSecret alongside google-auth-library Credentials, both clientId and clientSecret must be provided.',
          );
        }
      } else if (
        options.externalAccessTokenKey !== undefined ||
        options.clientId !== undefined ||
        options.clientSecret !== undefined ||
        hasScopes
      ) {
        throw new Error(
          'If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.',
        );
      }
    } else if (options.externalAccessTokenKey !== undefined) {
      if (
        options.clientId !== undefined ||
        options.clientSecret !== undefined ||
        hasScopes
      ) {
        throw new Error(
          'If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.',
        );
      }
    } else if (
      options.clientId === undefined ||
      options.clientSecret === undefined
    ) {
      throw new Error(
        'Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.',
      );
    }

    const normalizedCredentials =
      options.credentials !== undefined
        ? normalizeBigQueryCredentials(options.credentials, {
            clientId: options.clientId,
            clientSecret: options.clientSecret,
          })
        : undefined;
    this.credentials = normalizedCredentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;

    if (normalizedCredentials) {
      if (!isBigQueryAuthClient(normalizedCredentials)) {
        if (normalizedCredentials.clientId !== undefined) {
          this.clientId = normalizedCredentials.clientId;
        }
        if (normalizedCredentials.clientSecret !== undefined) {
          this.clientSecret = normalizedCredentials.clientSecret;
        }
        this.scopes = normalizedCredentials.scopes?.length
          ? [...normalizedCredentials.scopes]
          : [...BIGQUERY_SCOPES];
      } else {
        this.scopes = [...BIGQUERY_SCOPES];
      }
    } else if (options.scopes?.length) {
      this.scopes = [...options.scopes];
    } else {
      this.scopes = [...BIGQUERY_SCOPES];
    }

    this.tokenCacheKey = BIGQUERY_TOKEN_CACHE_KEY;
  }
}

/**
 * Internal credential manager that resolves, refreshes, and caches OAuth2
 * credentials for BigQuery tools.
 */
export class GoogleCredentialsManager {
  constructor(readonly credentialsConfig: BigQueryCredentialsConfig) {}

  /**
   * Builds a {@link GoogleOAuthCredentials} object from parsed cache JSON in
   * Google's authorized user format.
   */
  fromAuthorizedUserInfo(
    data: Record<string, unknown>,
    scopes?: string[],
  ): GoogleOAuthCredentials {
    const rawScopes = data['scopes'];
    const resolvedScopes = Array.isArray(rawScopes)
      ? rawScopes.filter((s): s is string => typeof s === 'string')
      : scopes
        ? [...scopes]
        : undefined;
    const rawExpiry = data['expiry'];
    const rawExpiresAt = optionalNumber(data['expires_at']);
    const expiry =
      typeof rawExpiry === 'string' || typeof rawExpiry === 'number'
        ? normalizeExpiry(rawExpiry)
        : normalizeExpiry(undefined, rawExpiresAt);

    return this.createOAuthCredentials({
      token: optionalString(data['token']),
      refreshToken: optionalString(data['refresh_token']),
      tokenUri: optionalString(data['token_uri']) ?? GOOGLE_OAUTH_TOKEN_URL,
      clientId: optionalString(data['client_id']),
      clientSecret: optionalString(data['client_secret']),
      scopes: resolvedScopes,
      ...(expiry !== undefined ? {expiry} : {}),
    });
  }

  /**
   * Creates a {@link BigQueryOAuthCredentials} instance from the given options.
   */
  createOAuthCredentials(
    options: BigQueryOAuthCredentialsOptions,
  ): GoogleOAuthCredentials {
    return new BigQueryOAuthCredentials(options);
  }

  /**
   * Retrieves valid credentials from state cache, existing config, token
   * refresh, or an interactive OAuth2 authorization code flow.
   *
   * @returns The credentials, or `undefined` while the user has not yet
   *     completed the OAuth2 authorization flow.
   */
  async getValidCredentials(
    toolContext?: Context,
  ): Promise<BigQueryCredentials | undefined> {
    const externalAccessTokenKey =
      this.credentialsConfig.externalAccessTokenKey;
    if (externalAccessTokenKey !== undefined) {
      const accessToken = toolContext?.state.get<unknown>(
        externalAccessTokenKey,
      );
      if (typeof accessToken === 'string' && accessToken.length > 0) {
        return this.createOAuthCredentials({token: accessToken});
      }
      throw new Error(
        `externalAccessTokenKey is provided but no access token found in toolContext.state with key ${externalAccessTokenKey}.`,
      );
    }

    const cacheKey = this.credentialsConfig.tokenCacheKey;
    const credsJson = toolContext?.state.get<unknown>(cacheKey);
    let creds: BigQueryCredentials | undefined;
    let fromCache = false;

    if (typeof credsJson === 'string' && credsJson.length > 0) {
      try {
        const credsData = JSON.parse(credsJson) as Record<string, unknown>;
        creds = this.fromAuthorizedUserInfo(
          credsData,
          this.credentialsConfig.scopes,
        );
        fromCache = true;
      } catch (err: unknown) {
        logger.debug(
          'Failed to deserialize cached BigQuery credentials; discarding cached state.',
          err,
        );
        creds = undefined;
      }
    }

    if (!creds) {
      creds = this.credentialsConfig.credentials;
    }

    const normalizedCreds =
      creds && !fromCache
        ? normalizeBigQueryCredentials(creds, {
            clientId: this.credentialsConfig.clientId,
            clientSecret: this.credentialsConfig.clientSecret,
          })
        : creds;

    if (
      normalizedCreds &&
      !fromCache &&
      isBigQueryAuthClient(normalizedCreds)
    ) {
      return normalizedCreds;
    }

    const oauthCreds = normalizedCreds as GoogleOAuthCredentials | undefined;

    if (oauthCreds?.valid) {
      return oauthCreds;
    }

    if (
      oauthCreds &&
      (oauthCreds.expired || !oauthCreds.token) &&
      oauthCreds.refreshToken &&
      oauthCreds.refresh
    ) {
      try {
        await oauthCreds.refresh();
        if (oauthCreds.valid) {
          // Only write back credentials that came from this user's session
          // cache. Configured credentials belong to the developer and must
          // not be copied into end-user session state.
          if (fromCache) {
            toolContext?.state.set(cacheKey, serializeCredentials(oauthCreds));
          }
          return oauthCreds;
        }
      } catch (err: unknown) {
        logger.warn('Failed to refresh expired BigQuery credentials:', err);
      }
    }

    // Credentials that do not report validity (for example, service account
    // credentials that mint tokens on demand) are refreshed once and used
    // without the interactive flow.
    if (
      oauthCreds &&
      !fromCache &&
      oauthCreds.valid === undefined &&
      !oauthCreds.expired &&
      typeof oauthCreds.refresh === 'function'
    ) {
      try {
        await oauthCreds.refresh();
      } catch (err: unknown) {
        logger.debug('Non-OAuth credential refresh failed:', err);
      }
      return oauthCreds;
    }

    return this.performOAuthFlow(toolContext);
  }

  private async performOAuthFlow(
    toolContext?: Context,
  ): Promise<GoogleOAuthCredentials | undefined> {
    if (!toolContext) {
      return undefined;
    }

    const scopesMap: Record<string, string> = {};
    for (const scope of this.credentialsConfig.scopes) {
      scopesMap[scope] = `Access to ${scope}`;
    }

    const authConfig: AuthConfig = {
      credentialKey: this.credentialsConfig.tokenCacheKey,
      authScheme: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
            tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
            scopes: scopesMap,
          },
        },
      },
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: this.credentialsConfig.clientId,
          clientSecret: this.credentialsConfig.clientSecret,
        },
      },
    };

    const authResponse = toolContext.getAuthResponse(authConfig);
    if (authResponse?.oauth2) {
      const oauth2 = authResponse.oauth2;
      const expiry =
        oauth2.expiresAt !== undefined
          ? normalizeExpiry(undefined, oauth2.expiresAt)
          : typeof oauth2.expiresIn === 'number' &&
              Number.isFinite(oauth2.expiresIn)
            ? new Date(Date.now() + oauth2.expiresIn * 1000).toISOString()
            : undefined;
      const creds = this.createOAuthCredentials({
        token: oauth2.accessToken,
        refreshToken: oauth2.refreshToken,
        tokenUri: GOOGLE_OAUTH_TOKEN_URL,
        clientId: this.credentialsConfig.clientId,
        clientSecret: this.credentialsConfig.clientSecret,
        scopes: [...this.credentialsConfig.scopes],
        ...(expiry !== undefined ? {expiry} : {}),
      });

      toolContext.state.set(
        this.credentialsConfig.tokenCacheKey,
        serializeCredentials(creds),
      );

      return creds;
    }

    toolContext.requestCredential(authConfig);
    return undefined;
  }
}
