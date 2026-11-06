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
  };
  return JSON.stringify(serialized);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
    const accessToken = optionalString(payload['access_token']);
    if (!accessToken) {
      throw new Error('Token refresh response did not contain access_token.');
    }
    this.token = accessToken;
    const refreshToken = optionalString(payload['refresh_token']);
    if (refreshToken !== undefined) {
      this.refreshToken = refreshToken;
    }
    this.expired = false;
    this.valid = true;
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
    };
    return JSON.stringify(serialized);
  }
}

/**
 * Configuration options for {@link BigQueryCredentialsConfig}.
 */
export interface BigQueryCredentialsConfigOptions {
  /**
   * Pre-existing Google OAuth2 credentials. Mutually exclusive with
   * `externalAccessTokenKey`, `clientId`, `clientSecret`, and `scopes`.
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

  constructor(options: BigQueryCredentialsConfigOptions = {}) {
    const hasScopes = Boolean(options.scopes?.length);

    if (options.credentials !== undefined) {
      if (
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

    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;

    if (this.credentials) {
      if (this.credentials.clientId !== undefined) {
        this.clientId = this.credentials.clientId;
      }
      if (this.credentials.clientSecret !== undefined) {
        this.clientSecret = this.credentials.clientSecret;
      }
      this.scopes = this.credentials.scopes?.length
        ? [...this.credentials.scopes]
        : [...BIGQUERY_SCOPES];
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

    return this.createOAuthCredentials({
      token: optionalString(data['token']),
      refreshToken: optionalString(data['refresh_token']),
      tokenUri: optionalString(data['token_uri']) ?? GOOGLE_OAUTH_TOKEN_URL,
      clientId: optionalString(data['client_id']),
      clientSecret: optionalString(data['client_secret']),
      scopes: resolvedScopes,
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
  ): Promise<GoogleOAuthCredentials | undefined> {
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

    if (creds?.valid) {
      return creds;
    }

    if (creds?.expired && creds.refreshToken && creds.refresh) {
      try {
        await creds.refresh();
        if (creds.valid) {
          // Only write back credentials that came from this user's session
          // cache. Configured credentials belong to the developer and must
          // not be copied into end-user session state.
          if (fromCache) {
            toolContext?.state.set(cacheKey, serializeCredentials(creds));
          }
          return creds;
        }
      } catch (err: unknown) {
        logger.debug('Failed to refresh expired BigQuery credentials:', err);
      }
    }

    // Credentials that do not report validity (for example, service account
    // credentials that mint tokens on demand) are refreshed once and used
    // without the interactive flow.
    if (
      creds &&
      !fromCache &&
      creds.valid === undefined &&
      !creds.expired &&
      creds.refresh
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
      const creds = this.createOAuthCredentials({
        token: authResponse.oauth2.accessToken,
        refreshToken: authResponse.oauth2.refreshToken,
        tokenUri: GOOGLE_OAUTH_TOKEN_URL,
        clientId: this.credentialsConfig.clientId,
        clientSecret: this.credentialsConfig.clientSecret,
        scopes: [...this.credentialsConfig.scopes],
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
