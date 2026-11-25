/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  type BaseGoogleCredentialsConfigOptions,
  isGoogleAuthClient,
} from '@google/adk';

/**
 * Session state key used to cache serialized Spanner OAuth2 credentials.
 */
export const SPANNER_TOKEN_CACHE_KEY = 'spanner_token_cache';

/**
 * Default OAuth2 scopes requested for Cloud Spanner database admin metadata and
 * data operations.
 */
export const SPANNER_DEFAULT_SCOPE: readonly string[] = Object.freeze([
  'https://www.googleapis.com/auth/spanner.admin',
  'https://www.googleapis.com/auth/spanner.data',
]);

/**
 * Configuration options for {@link SpannerCredentialsConfig}.
 */
export interface SpannerCredentialsConfigOptions extends BaseGoogleCredentialsConfigOptions {
  /**
   * OAuth2 scopes to request. Defaults to {@link SPANNER_DEFAULT_SCOPE} when
   * omitted or empty.
   */
  scopes?: readonly string[];

  /**
   * Session state key used to cache serialized OAuth2 credentials. Defaults to
   * {@link SPANNER_TOKEN_CACHE_KEY}.
   */
  tokenCacheKey?: string;
}

const SPANNER_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.spannerCredentialsConfig',
);

/**
 * Type guard checking whether a value is an instance of
 * {@link SpannerCredentialsConfig}.
 */
export function isSpannerCredentialsConfig(
  obj: unknown,
): obj is SpannerCredentialsConfig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    SPANNER_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[
      SPANNER_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL
    ] === true
  );
}

function resolveSpannerScopes(
  options: SpannerCredentialsConfigOptions,
): string[] {
  if (options.credentials !== undefined) {
    if (
      !isGoogleAuthClient(options.credentials) &&
      options.credentials.scopes?.length
    ) {
      return [...options.credentials.scopes];
    }
    return [...SPANNER_DEFAULT_SCOPE];
  }
  if (options.scopes?.length) {
    return [...options.scopes];
  }
  return [...SPANNER_DEFAULT_SCOPE];
}

/**
 * Credentials configuration for Cloud Spanner tools and {@link SpannerToolset}.
 */
export class SpannerCredentialsConfig extends BaseGoogleCredentialsConfig {
  readonly [SPANNER_CREDENTIALS_CONFIG_SIGNATURE_SYMBOL] = true;

  /**
   * OAuth2 scopes to request or apply.
   */
  override readonly scopes: string[];

  /**
   * Session state key used to cache OAuth2 tokens.
   */
  override readonly tokenCacheKey: string;

  constructor(options: SpannerCredentialsConfigOptions = {}) {
    const tokenCacheKey = options.tokenCacheKey ?? SPANNER_TOKEN_CACHE_KEY;
    const resolvedScopes = resolveSpannerScopes(options);

    // Only supply default scopes to the base class when interactive client
    // credentials are configured so base mutual-exclusivity checks remain intact.
    const superOptions: BaseGoogleCredentialsConfigOptions =
      options.credentials !== undefined ||
      options.externalAccessTokenKey !== undefined
        ? {...options, tokenCacheKey}
        : {...options, scopes: resolvedScopes, tokenCacheKey};

    super(superOptions);

    this.scopes = resolvedScopes;
    this.tokenCacheKey = tokenCacheKey;
  }
}
