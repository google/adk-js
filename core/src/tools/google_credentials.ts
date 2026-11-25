/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {AuthCredential, AuthCredentialTypes} from '../auth/auth_credential.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {stableHash} from '../utils/hash_utils.js';
import {logger} from '../utils/logger.js';

const GOOGLE_OAUTH_AUTHORIZATION_URL =
  'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Clock-skew and in-flight leeway subtracted from token expiry checks, matching
 * `isTokenExpired`'s 60-second default.
 */
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;

function isIsoTimestampExpired(expiry?: string): boolean {
  if (expiry !== undefined) {
    const expiryMs = Date.parse(expiry);
    if (!Number.isNaN(expiryMs)) {
      return expiryMs - TOKEN_EXPIRY_LEEWAY_MS <= Date.now();
    }
  }
  return false;
}

function isOAuthCredentialExpired(creds: GoogleOAuthCredentials): boolean {
  if (creds.expired !== undefined) {
    return creds.expired;
  }
  return isIsoTimestampExpired(creds.expiry);
}

function isOAuthCredentialValid(creds: GoogleOAuthCredentials): boolean {
  return (
    creds.valid ?? (Boolean(creds.token) && !isOAuthCredentialExpired(creds))
  );
}

/**
 * Structural interface for an authentication client (such as a
 * `google-auth-library` `AuthClient`, `OAuth2Client`, `JWT`, or `GoogleAuth`)
 * that supplies request headers on demand.
 */
export interface GoogleAuthClient {
  /**
   * Returns HTTP request headers for authenticating a Google API request.
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
 * {@link GoogleAuthClient}.
 */
export function isGoogleAuthClient(
  credentials: unknown,
): credentials is GoogleAuthClient {
  return (
    typeof credentials === 'object' &&
    credentials !== null &&
    'getRequestHeaders' in credentials &&
    typeof credentials.getRequestHeaders === 'function'
  );
}

/**
 * Google OAuth2 credentials used to authenticate Google API requests.
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
}

/**
 * Credentials accepted by Google API tools: either an OAuth2 credential object
 * ({@link GoogleOAuthCredentials}) or an auth client that produces request
 * headers ({@link GoogleAuthClient}).
 */
export type GoogleCredentials = GoogleOAuthCredentials | GoogleAuthClient;

/**
 * Serialized form of OAuth2 credentials stored in the session cache using
 * Google's authorized user JSON format.
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

const GOOGLE_OAUTH_REFRESH_ERROR_SYMBOL = Symbol.for(
  'google.adk.googleOAuthRefreshError',
);

/**
 * Type guard checking whether a value is a {@link GoogleOAuthRefreshError}.
 */
export function isGoogleOAuthRefreshError(
  obj: unknown,
): obj is GoogleOAuthRefreshError {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GOOGLE_OAUTH_REFRESH_ERROR_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[GOOGLE_OAUTH_REFRESH_ERROR_SYMBOL] === true
  );
}

/**
 * Error thrown when an OAuth2 token refresh request is rejected by the token
 * endpoint or lacks required refresh credentials, signaling that interactive
 * re-authentication is needed.
 */
export class GoogleOAuthRefreshError extends Error {
  readonly [GOOGLE_OAUTH_REFRESH_ERROR_SYMBOL] = true;
  readonly status?: number;

  constructor(message: string, options?: {status?: number; cause?: unknown}) {
    super(
      message,
      options?.cause !== undefined ? {cause: options.cause} : undefined,
    );
    this.name = 'GoogleOAuthRefreshError';
    this.status = options?.status;
  }
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
 * Options for constructing {@link GoogleOAuthCredentialsImpl}.
 */
export interface GoogleOAuthCredentialsOptions {
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
  scopes?: readonly string[];

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

const GOOGLE_OAUTH_CREDENTIALS_IMPL_SYMBOL = Symbol.for(
  'google.adk.googleOAuthCredentialsImpl',
);

/**
 * Type guard checking whether a value is a {@link GoogleOAuthCredentialsImpl}.
 */
export function isGoogleOAuthCredentialsImpl(
  obj: unknown,
): obj is GoogleOAuthCredentialsImpl {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GOOGLE_OAUTH_CREDENTIALS_IMPL_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[GOOGLE_OAUTH_CREDENTIALS_IMPL_SYMBOL] ===
      true
  );
}

/**
 * Concrete OAuth2 credentials implementation supporting expiry leeway checks,
 * session serialization, and token refresh via `fetch`.
 */
export class GoogleOAuthCredentialsImpl implements GoogleOAuthCredentials {
  readonly [GOOGLE_OAUTH_CREDENTIALS_IMPL_SYMBOL] = true;

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

  constructor(options: GoogleOAuthCredentialsOptions = {}) {
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
    return isIsoTimestampExpired(this.expiry);
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
   * Refreshes the OAuth2 access token using the configured refresh handler or
   * the OAuth2 token endpoint.
   *
   * @throws {GoogleOAuthRefreshError} When refresh credentials are missing, the
   *     token endpoint returns a non-OK status, or the payload omits
   *     `access_token`.
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
      throw new GoogleOAuthRefreshError(
        'Cannot refresh credentials without a refresh token.',
      );
    }
    if (!this.clientId || !this.clientSecret) {
      throw new GoogleOAuthRefreshError(
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
      throw new GoogleOAuthRefreshError(
        `Failed to refresh OAuth2 token: HTTP ${response.status}.`,
        {status: response.status},
      );
    }
    const rawPayload: unknown = await response.json();
    if (
      typeof rawPayload !== 'object' ||
      rawPayload === null ||
      Array.isArray(rawPayload)
    ) {
      throw new GoogleOAuthRefreshError(
        'Token refresh response did not contain a JSON object.',
      );
    }
    const payload = rawPayload as Record<string, unknown>;
    const accessToken = optionalString(payload['access_token']);
    if (!accessToken) {
      throw new GoogleOAuthRefreshError(
        'Token refresh response did not contain access_token.',
      );
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
 * Configuration options for {@link BaseGoogleCredentialsConfig}.
 */
export interface BaseGoogleCredentialsConfigOptions {
  /**
   * Pre-existing Google OAuth2 credentials or `google-auth-library` client.
   * Mutually exclusive with `externalAccessTokenKey`, `clientId`,
   * `clientSecret`, and non-empty `scopes`.
   */
  credentials?: GoogleCredentials;

  /**
   * Session state key holding an external OAuth2 access token. Mutually
   * exclusive with `credentials`, `clientId`, `clientSecret`, and non-empty
   * `scopes`.
   */
  externalAccessTokenKey?: string;

  /**
   * OAuth2 client ID used for the interactive OAuth2 authorization code flow.
   */
  clientId?: string;

  /**
   * OAuth2 client secret used for the interactive OAuth2 authorization code
   * flow.
   */
  clientSecret?: string;

  /**
   * OAuth2 scopes to request.
   */
  scopes?: readonly string[];

  /**
   * Optional session state key used to cache serialized OAuth2 credentials.
   * When omitted, session state caching is skipped.
   */
  tokenCacheKey?: string;
}

const BASE_GOOGLE_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.baseGoogleCredentialsConfig',
);

/**
 * Type guard checking whether an object is an instance of
 * {@link BaseGoogleCredentialsConfig}.
 */
export function isBaseGoogleCredentialsConfig(
  obj: unknown,
): obj is BaseGoogleCredentialsConfig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_GOOGLE_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[
      BASE_GOOGLE_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL
    ] === true
  );
}

/**
 * Base Google credentials configuration for {@link GoogleTool} and Google API
 * toolsets.
 */
export class BaseGoogleCredentialsConfig {
  readonly [BASE_GOOGLE_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL] = true;

  /**
   * Pre-existing credentials when configured.
   */
  readonly credentials?: GoogleCredentials;

  /**
   * Session state key from which to read an external access token.
   */
  readonly externalAccessTokenKey?: string;

  /**
   * OAuth2 client ID.
   */
  readonly clientId?: string;

  /**
   * OAuth2 client secret.
   */
  readonly clientSecret?: string;

  /**
   * OAuth2 scopes to request or apply.
   */
  readonly scopes?: string[];

  /**
   * Optional session state key used to cache OAuth2 tokens.
   */
  readonly tokenCacheKey?: string;

  constructor(options: BaseGoogleCredentialsConfigOptions = {}) {
    const hasCredentials = options.credentials !== undefined;
    const hasExternalKey = options.externalAccessTokenKey !== undefined;
    const hasClientId = options.clientId !== undefined;
    const hasClientSecret = options.clientSecret !== undefined;
    const hasScopes = Boolean(options.scopes?.length);

    if (hasCredentials) {
      if (hasExternalKey || hasClientId || hasClientSecret || hasScopes) {
        throw new Error(
          'If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.',
        );
      }
    } else if (hasExternalKey) {
      if (hasClientId || hasClientSecret || hasScopes) {
        throw new Error(
          'If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.',
        );
      }
      if (!options.externalAccessTokenKey?.trim()) {
        throw new Error(
          'externalAccessTokenKey must be a non-empty string. Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.',
        );
      }
    } else if (!options.clientId?.trim() || !options.clientSecret?.trim()) {
      throw new Error(
        'Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.',
      );
    }

    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.tokenCacheKey = options.tokenCacheKey;

    if (this.credentials && !isGoogleAuthClient(this.credentials)) {
      this.clientId = this.credentials.clientId;
      this.clientSecret = this.credentials.clientSecret;
      this.scopes = this.credentials.scopes?.length
        ? [...this.credentials.scopes]
        : undefined;
    } else {
      this.clientId = options.clientId;
      this.clientSecret = options.clientSecret;
      this.scopes = options.scopes?.length ? [...options.scopes] : undefined;
    }
  }
}

function fromAuthorizedUserInfo(
  data: Record<string, unknown>,
  scopes?: readonly string[],
): GoogleOAuthCredentialsImpl {
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

  return new GoogleOAuthCredentialsImpl({
    token: optionalString(data['token']),
    refreshToken: optionalString(data['refresh_token']),
    tokenUri: optionalString(data['token_uri']) ?? GOOGLE_OAUTH_TOKEN_URL,
    clientId: optionalString(data['client_id']),
    clientSecret: optionalString(data['client_secret']),
    scopes: resolvedScopes,
    ...(expiry !== undefined ? {expiry} : {}),
  });
}

function buildDefaultCredentialKey(
  authScheme: AuthScheme,
  authCredential: AuthCredential,
): string {
  return `adk_${authScheme.type}_${stableHash(authScheme)}_${authCredential.authType}_${stableHash(authCredential)}`;
}

interface RefreshableCredentialFields {
  valid?: boolean;
  expired?: boolean;
  refresh?: () => void | Promise<void>;
}

function hasRefreshableValidContract(
  value: GoogleAuthClient,
): value is GoogleAuthClient & RefreshableCredentialFields {
  return (
    'refresh' in value &&
    typeof value.refresh === 'function' &&
    ('valid' in value || 'expired' in value)
  );
}

function isNonOAuthCredentialObject(creds: GoogleOAuthCredentials): boolean {
  return (
    !isGoogleOAuthCredentialsImpl(creds) &&
    creds.refreshToken === undefined &&
    creds.clientId === undefined &&
    creds.clientSecret === undefined &&
    typeof creds.refresh === 'function'
  );
}

const GOOGLE_CREDENTIALS_MANAGER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.googleCredentialsManager',
);

/**
 * Type guard checking whether an object is an instance of
 * {@link GoogleCredentialsManager}.
 */
export function isGoogleCredentialsManager(
  obj: unknown,
): obj is GoogleCredentialsManager {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GOOGLE_CREDENTIALS_MANAGER_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[
      GOOGLE_CREDENTIALS_MANAGER_SIGNATURE_SYMBOL
    ] === true
  );
}

/**
 * Centralizes Google API credential resolution, refresh, OAuth2 flow
 * handling, and optional session state caching across Google tools.
 */
export class GoogleCredentialsManager {
  readonly [GOOGLE_CREDENTIALS_MANAGER_SIGNATURE_SYMBOL] = true;

  constructor(readonly credentialsConfig: BaseGoogleCredentialsConfig) {}

  /**
   * Retrieves valid credentials from external state, session cache, existing
   * configuration, token refresh, or an interactive OAuth2 flow.
   *
   * @param toolContext The tool context used for state lookup and OAuth2
   *     credential exchange.
   * @returns Valid credentials, or `undefined` when interactive authorization is
   *     pending.
   */
  async getValidCredentials(
    toolContext?: Context,
  ): Promise<GoogleCredentials | undefined> {
    const externalAccessTokenKey =
      this.credentialsConfig.externalAccessTokenKey;
    if (externalAccessTokenKey !== undefined) {
      const accessToken = toolContext?.state.get<unknown>(
        externalAccessTokenKey,
      );
      if (typeof accessToken === 'string' && accessToken.length > 0) {
        return new GoogleOAuthCredentialsImpl({token: accessToken});
      }
      throw new Error(
        `externalAccessTokenKey is provided but no access token found in toolContext.state with key ${externalAccessTokenKey}.`,
      );
    }

    const cacheKey = this.credentialsConfig.tokenCacheKey;
    const credsJson = cacheKey
      ? toolContext?.state.get<unknown>(cacheKey)
      : undefined;
    let creds: GoogleCredentials | undefined;
    let fromCache = false;

    if (typeof credsJson === 'string' && credsJson.length > 0) {
      try {
        const parsed: unknown = JSON.parse(credsJson);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error('Cached credentials payload must be a JSON object.');
        }
        creds = fromAuthorizedUserInfo(
          parsed as Record<string, unknown>,
          this.credentialsConfig.scopes,
        );
        fromCache = true;
      } catch (err: unknown) {
        logger.warn(
          'Failed to deserialize cached Google credentials; discarding cached state.',
          err,
        );
        creds = undefined;
      }
    }

    if (!creds) {
      creds = this.credentialsConfig.credentials;
    }

    if (creds && !fromCache && isGoogleAuthClient(creds)) {
      if (
        hasRefreshableValidContract(creds) &&
        (creds.valid === false ||
          (creds.valid === undefined && creds.expired === true))
      ) {
        try {
          await creds.refresh?.();
        } catch (err: unknown) {
          logger.debug('Non-OAuth auth client refresh failed:', err);
        }
      }
      return creds;
    }

    const oauthCreds = creds as GoogleOAuthCredentials | undefined;

    if (oauthCreds && !fromCache && isNonOAuthCredentialObject(oauthCreds)) {
      if (!isOAuthCredentialValid(oauthCreds)) {
        try {
          await oauthCreds.refresh?.();
        } catch (err: unknown) {
          logger.debug('Non-OAuth credential refresh failed:', err);
        }
      }
      return oauthCreds;
    }

    if (oauthCreds && isOAuthCredentialValid(oauthCreds)) {
      return oauthCreds;
    }

    if (
      oauthCreds &&
      isOAuthCredentialExpired(oauthCreds) &&
      oauthCreds.refreshToken &&
      oauthCreds.refresh
    ) {
      try {
        await oauthCreds.refresh();
        if (isOAuthCredentialValid(oauthCreds)) {
          // Only persist refreshed tokens that originated from this user's
          // session cache so developer credentials never leak into state.
          if (fromCache && cacheKey) {
            toolContext?.state.set(cacheKey, serializeCredentials(oauthCreds));
          }
          return oauthCreds;
        }
      } catch (err: unknown) {
        if (!isGoogleOAuthRefreshError(err)) {
          throw err;
        }
        logger.debug('Failed to refresh expired Google credentials:', err);
      }
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
    for (const scope of this.credentialsConfig.scopes ?? []) {
      scopesMap[scope] = `Access to ${scope}`;
    }

    const authScheme: AuthScheme = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
          tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
          scopes: scopesMap,
        },
      },
    };
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: this.credentialsConfig.clientId,
        clientSecret: this.credentialsConfig.clientSecret,
      },
    };
    const authConfig: AuthConfig = {
      credentialKey:
        this.credentialsConfig.tokenCacheKey ||
        buildDefaultCredentialKey(authScheme, rawAuthCredential),
      authScheme,
      rawAuthCredential,
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
      const creds = new GoogleOAuthCredentialsImpl({
        token: oauth2.accessToken,
        refreshToken: oauth2.refreshToken,
        tokenUri: GOOGLE_OAUTH_TOKEN_URL,
        clientId: this.credentialsConfig.clientId,
        clientSecret: this.credentialsConfig.clientSecret,
        scopes: this.credentialsConfig.scopes,
        ...(expiry !== undefined ? {expiry} : {}),
      });

      if (this.credentialsConfig.tokenCacheKey) {
        toolContext.state.set(
          this.credentialsConfig.tokenCacheKey,
          serializeCredentials(creds),
        );
      }

      return creds;
    }

    toolContext.requestCredential(authConfig);
    return undefined;
  }
}
