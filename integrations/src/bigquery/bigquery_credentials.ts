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
  type OAuth2Auth,
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

const ALLOWED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'credentials',
  'externalAccessTokenKey',
  'clientId',
  'clientSecret',
  'scopes',
]);

/**
 * Structural interface representing Google OAuth2 or Google Auth credentials.
 */
export interface GoogleOAuthCredentials {
  /**
   * OAuth2 access token.
   */
  token?: string;

  /**
   * Optional camelCase alias for the OAuth2 access token.
   */
  accessToken?: string;

  /**
   * OAuth2 refresh token used to obtain a new access token when expired.
   */
  refreshToken?: string;

  /**
   * Optional snake_case refresh token field from serialized Google credentials.
   */
  refresh_token?: string;

  /**
   * Token endpoint URI used to refresh tokens.
   */
  tokenUri?: string;

  /**
   * Optional snake_case token URI field from serialized Google credentials.
   */
  token_uri?: string;

  /**
   * OAuth2 client ID associated with the credentials.
   */
  clientId?: string;

  /**
   * Optional snake_case client ID field from serialized Google credentials.
   */
  client_id?: string;

  /**
   * OAuth2 client secret associated with the credentials.
   */
  clientSecret?: string;

  /**
   * Optional snake_case client secret field from serialized Google credentials.
   */
  client_secret?: string;

  /**
   * OAuth2 scopes granted to or requested by the credentials.
   */
  scopes?: string[];

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
  refresh?: (request?: unknown) => void | Promise<void>;

  /**
   * Serializes the credentials to a JSON string.
   */
  toJson?: () => string;

  /**
   * Optional snake_case JSON serializer for Google OAuth credentials.
   */
  to_json?: () => string;
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
  refreshHandler?: () => Promise<{token: string; refreshToken?: string}>;
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
  valid: boolean;
  expired: boolean;
  private readonly refreshHandler?: () => Promise<{
    token: string;
    refreshToken?: string;
  }>;

  constructor(options: BigQueryOAuthCredentialsOptions = {}) {
    this.token = options.token;
    this.refreshToken = options.refreshToken;
    this.tokenUri = options.tokenUri ?? GOOGLE_OAUTH_TOKEN_URL;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scopes = options.scopes ? [...options.scopes] : undefined;
    this.expired = options.expired ?? false;
    this.valid = options.valid ?? (Boolean(this.token) && !this.expired);
    this.refreshHandler = options.refreshHandler;
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
      this.expired = false;
      this.valid = Boolean(this.token);
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
    const accessToken = payload['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('Token refresh response did not contain access_token.');
    }
    this.token = accessToken;
    if (typeof payload['refresh_token'] === 'string') {
      this.refreshToken = payload['refresh_token'];
    }
    this.expired = false;
    this.valid = true;
  }

  /**
   * Serializes the credentials to a JSON string for session caching.
   */
  toJson(): string {
    return JSON.stringify({
      token: this.token,
      refresh_token: this.refreshToken,
      token_uri: this.tokenUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scopes: this.scopes,
    });
  }
}

/**
 * Configuration options for {@link BigQueryCredentialsConfig}.
 */
export interface BigQueryCredentialsConfigOptions {
  /**
   * Pre-existing Google OAuth2 or Google Auth credentials. Mutually exclusive
   * with `externalAccessTokenKey`, `clientId`, `clientSecret`, and `scopes`.
   */
  credentials?: GoogleOAuthCredentials;

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
  credentials?: GoogleOAuthCredentials;

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

  constructor(options?: BigQueryCredentialsConfigOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error(
        'Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.',
      );
    }

    for (const key of Object.keys(options)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        throw new Error(
          `Unexpected property '${key}' in BigQueryCredentialsConfig.`,
        );
      }
    }

    if (options.credentials) {
      if (
        options.externalAccessTokenKey ||
        options.clientId ||
        options.clientSecret ||
        options.scopes
      ) {
        throw new Error(
          'If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.',
        );
      }
    } else if (options.externalAccessTokenKey) {
      if (options.clientId || options.clientSecret || options.scopes) {
        throw new Error(
          'If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.',
        );
      }
    } else if (!options.clientId || !options.clientSecret) {
      throw new Error(
        'Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.',
      );
    }

    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;

    if (this.credentials) {
      const credsClientId =
        this.credentials.clientId ?? this.credentials.client_id;
      const credsClientSecret =
        this.credentials.clientSecret ?? this.credentials.client_secret;
      if (credsClientId !== undefined) {
        this.clientId = credsClientId;
      }
      if (credsClientSecret !== undefined) {
        this.clientSecret = credsClientSecret;
      }
      if (this.credentials.scopes && this.credentials.scopes.length > 0) {
        this.scopes = [...this.credentials.scopes];
      } else {
        this.scopes = [...BIGQUERY_SCOPES];
      }
    } else if (options.scopes && options.scopes.length > 0) {
      this.scopes = [...options.scopes];
    } else {
      this.scopes = [...BIGQUERY_SCOPES];
    }

    this.tokenCacheKey = BIGQUERY_TOKEN_CACHE_KEY;
  }
}

function getStateValue(toolContext: Context | undefined, key: string): unknown {
  const state = toolContext?.state as
    {get?: (k: string) => unknown} | Record<string, unknown> | undefined;
  if (!state) {
    return undefined;
  }
  if (typeof state.get === 'function') {
    return state.get(key);
  }
  return (state as Record<string, unknown>)[key];
}

function setStateValue(
  toolContext: Context | undefined,
  key: string,
  value: unknown,
): void {
  const state = toolContext?.state as
    | {set?: (k: string, v: unknown) => void}
    | Record<string, unknown>
    | undefined;
  if (!state) {
    return;
  }
  if (typeof state.set === 'function') {
    state.set(key, value);
    return;
  }
  (state as Record<string, unknown>)[key] = value;
}

function serializeCredentials(creds: GoogleOAuthCredentials): string {
  if (typeof creds.toJson === 'function') {
    return creds.toJson();
  }
  if (typeof creds.to_json === 'function') {
    return creds.to_json();
  }
  return JSON.stringify({
    token: creds.token ?? creds.accessToken,
    refresh_token: creds.refreshToken ?? creds.refresh_token,
    token_uri: creds.tokenUri ?? creds.token_uri ?? GOOGLE_OAUTH_TOKEN_URL,
    client_id: creds.clientId ?? creds.client_id,
    client_secret: creds.clientSecret ?? creds.client_secret,
    scopes: creds.scopes,
  });
}

/**
 * Internal credential manager that resolves, refreshes, and caches OAuth2
 * credentials for BigQuery tools.
 */
export class GoogleCredentialsManager {
  constructor(readonly credentialsConfig: BigQueryCredentialsConfig) {}

  /**
   * Builds a {@link GoogleOAuthCredentials} object from parsed authorized user JSON.
   */
  fromAuthorizedUserInfo(
    data: Record<string, unknown>,
    scopes?: string[],
  ): GoogleOAuthCredentials {
    const token =
      typeof data['token'] === 'string'
        ? data['token']
        : typeof data['access_token'] === 'string'
          ? data['access_token']
          : typeof data['accessToken'] === 'string'
            ? data['accessToken']
            : undefined;
    const refreshToken =
      typeof data['refresh_token'] === 'string'
        ? data['refresh_token']
        : typeof data['refreshToken'] === 'string'
          ? data['refreshToken']
          : undefined;
    const tokenUri =
      typeof data['token_uri'] === 'string'
        ? data['token_uri']
        : typeof data['tokenUri'] === 'string'
          ? data['tokenUri']
          : GOOGLE_OAUTH_TOKEN_URL;
    const clientId =
      typeof data['client_id'] === 'string'
        ? data['client_id']
        : typeof data['clientId'] === 'string'
          ? data['clientId']
          : undefined;
    const clientSecret =
      typeof data['client_secret'] === 'string'
        ? data['client_secret']
        : typeof data['clientSecret'] === 'string'
          ? data['clientSecret']
          : undefined;
    const resolvedScopes = Array.isArray(data['scopes'])
      ? data['scopes'].filter((s): s is string => typeof s === 'string')
      : scopes
        ? [...scopes]
        : undefined;
    const expired =
      typeof data['expired'] === 'boolean' ? data['expired'] : false;
    const valid =
      typeof data['valid'] === 'boolean'
        ? data['valid']
        : Boolean(token) && !expired;

    return this.createOAuthCredentials({
      token,
      refreshToken,
      tokenUri,
      clientId,
      clientSecret,
      scopes: resolvedScopes,
      expired,
      valid,
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
   */
  async getValidCredentials(
    toolContext?: Context,
  ): Promise<GoogleOAuthCredentials | null> {
    if (this.credentialsConfig.externalAccessTokenKey) {
      const accessToken = getStateValue(
        toolContext,
        this.credentialsConfig.externalAccessTokenKey,
      );
      if (typeof accessToken === 'string' && accessToken.length > 0) {
        return this.createOAuthCredentials({token: accessToken});
      }
      throw new Error(
        `externalAccessTokenKey is provided but no access token found in toolContext.state with key ${this.credentialsConfig.externalAccessTokenKey}.`,
      );
    }

    const cacheKey = this.credentialsConfig.tokenCacheKey;
    const credsJson = cacheKey
      ? getStateValue(toolContext, cacheKey)
      : undefined;
    let creds: GoogleOAuthCredentials | undefined;
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

    if (creds && creds.valid) {
      return creds;
    }

    const refreshToken = creds?.refreshToken ?? creds?.refresh_token;
    if (
      creds &&
      creds.expired &&
      refreshToken &&
      typeof creds.refresh === 'function'
    ) {
      try {
        await creds.refresh();
        if (creds.valid) {
          if (cacheKey) {
            setStateValue(toolContext, cacheKey, serializeCredentials(creds));
          }
          return creds;
        }
      } catch (err: unknown) {
        logger.debug('Failed to refresh expired BigQuery credentials:', err);
      }
    }

    if (
      creds &&
      !fromCache &&
      creds.valid === undefined &&
      !creds.expired &&
      typeof creds.refresh === 'function'
    ) {
      try {
        await creds.refresh();
      } catch (err: unknown) {
        logger.debug('Non-OAuth credential refresh failed:', err);
      }
      return creds;
    }

    return this.performOAuthFlow(toolContext);
  }

  private async performOAuthFlow(
    toolContext?: Context,
  ): Promise<GoogleOAuthCredentials | null> {
    if (!toolContext) {
      return null;
    }

    const scopesMap: Record<string, string> = {};
    for (const scope of this.credentialsConfig.scopes ?? []) {
      scopesMap[scope] = `Access to ${scope}`;
    }

    const authConfig: AuthConfig = {
      credentialKey:
        this.credentialsConfig.tokenCacheKey || BIGQUERY_TOKEN_CACHE_KEY,
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
      const oauth2Response = authResponse.oauth2 as OAuth2Auth & {
        access_token?: string;
        refresh_token?: string;
      };
      const accessToken =
        oauth2Response.accessToken ?? oauth2Response.access_token;
      const refreshToken =
        oauth2Response.refreshToken ?? oauth2Response.refresh_token;

      const creds = this.createOAuthCredentials({
        token: accessToken,
        refreshToken,
        tokenUri: GOOGLE_OAUTH_TOKEN_URL,
        clientId: this.credentialsConfig.clientId,
        clientSecret: this.credentialsConfig.clientSecret,
        scopes: this.credentialsConfig.scopes
          ? [...this.credentialsConfig.scopes]
          : undefined,
      });

      if (this.credentialsConfig.tokenCacheKey) {
        setStateValue(
          toolContext,
          this.credentialsConfig.tokenCacheKey,
          serializeCredentials(creds),
        );
      }

      return creds;
    }

    toolContext.requestCredential(authConfig);
    return null;
  }
}
