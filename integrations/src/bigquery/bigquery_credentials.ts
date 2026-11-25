/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  type BaseGoogleCredentialsConfigOptions,
  type GoogleAuthClient,
  type GoogleCredentials,
  type GoogleOAuthCredentials,
  GoogleOAuthCredentialsImpl,
  type GoogleOAuthCredentialsOptions,
  isGoogleAuthClient,
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

export type {GoogleOAuthCredentials};

/**
 * Structural interface for an authentication client (such as a
 * `google-auth-library` `AuthClient`, `OAuth2Client`, `JWT`, or `GoogleAuth`)
 * that supplies request headers on demand.
 *
 * @deprecated Use {@link GoogleAuthClient} from `@google/adk` instead.
 */
export type BigQueryAuthClient = GoogleAuthClient;

/**
 * Type guard checking whether a credential object implements
 * {@link BigQueryAuthClient}.
 *
 * @deprecated Use {@link isGoogleAuthClient} from `@google/adk` instead.
 */
export function isBigQueryAuthClient(
  credentials: unknown,
): credentials is BigQueryAuthClient {
  return isGoogleAuthClient(credentials);
}

/**
 * Credentials accepted by BigQuery tools and client helpers: either an OAuth2
 * credential object ({@link GoogleOAuthCredentials}) or an auth client that
 * produces request headers ({@link GoogleAuthClient}).
 *
 * @deprecated Use {@link GoogleCredentials} from `@google/adk` instead.
 */
export type BigQueryCredentials = GoogleCredentials;

/**
 * Options for constructing {@link BigQueryOAuthCredentials}.
 *
 * @deprecated Use {@link GoogleOAuthCredentialsOptions} from `@google/adk` instead.
 */
export type BigQueryOAuthCredentialsOptions = GoogleOAuthCredentialsOptions;

/**
 * Concrete OAuth2 credentials implementation for BigQuery tools.
 *
 * @deprecated Use {@link GoogleOAuthCredentialsImpl} from `@google/adk` instead.
 */
export class BigQueryOAuthCredentials extends GoogleOAuthCredentialsImpl {}

/**
 * Configuration options for {@link BigQueryCredentialsConfig}.
 */
export interface BigQueryCredentialsConfigOptions extends Omit<
  BaseGoogleCredentialsConfigOptions,
  'tokenCacheKey'
> {
  /**
   * Pre-existing Google OAuth2 credentials or `google-auth-library` client.
   * Mutually exclusive with `externalAccessTokenKey`, `clientId`,
   * `clientSecret`, and `scopes`.
   */
  credentials?: GoogleCredentials;

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
  scopes?: readonly string[];
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

function resolveBigQueryScopes(
  options: BigQueryCredentialsConfigOptions,
): string[] {
  const configuredScopes =
    options.credentials && !isGoogleAuthClient(options.credentials)
      ? options.credentials.scopes
      : options.scopes;
  return configuredScopes?.length
    ? [...configuredScopes]
    : [...BIGQUERY_SCOPES];
}

/**
 * Configuration for Google BigQuery API authentication in `GoogleTool` and
 * `BigQueryToolset`.
 */
export class BigQueryCredentialsConfig extends BaseGoogleCredentialsConfig {
  readonly [BIGQUERY_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL] = true;

  /**
   * OAuth2 scopes to request or apply.
   */
  override readonly scopes: string[];

  /**
   * Session state key used to cache OAuth2 tokens.
   */
  override readonly tokenCacheKey: string;

  constructor(options: BigQueryCredentialsConfigOptions = {}) {
    super({
      ...options,
      tokenCacheKey: BIGQUERY_TOKEN_CACHE_KEY,
    });

    // Compute and assign after super() so class field ordering cannot reset
    // scopes or tokenCacheKey back to undefined.
    this.scopes = resolveBigQueryScopes(options);
    this.tokenCacheKey = BIGQUERY_TOKEN_CACHE_KEY;
  }
}
