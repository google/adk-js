/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration options for node execution retries upon transient failures.
 */
export interface RetryConfig {
  /**
   * Maximum number of execution attempts (including the initial attempt).
   * Must be >= 1.
   */
  maxAttempts: number;

  /**
   * Initial delay in milliseconds before the first retry.
   * Default is 1000ms (1 second).
   */
  initialDelayMs?: number;

  /**
   * Maximum delay in milliseconds between retries.
   * Default is 30000ms (30 seconds).
   */
  maxDelayMs?: number;

  /**
   * Multiplier applied to the delay after each retry attempt (exponential backoff).
   * Default is 2.0.
   */
  backoffFactor?: number;

  /**
   * Optional array of Error constructors or error message patterns that should trigger a retry.
   * If not specified, all errors are considered retryable up to `maxAttempts`.
   */
  retryableErrors?: Array<new (...args: unknown[]) => Error | string | RegExp>;
}

/**
 * Validates and normalizes a RetryConfig into canonical defaults.
 * @param config Optional user-provided RetryConfig.
 * @returns Normalized RetryConfig or undefined if not provided.
 */
export function normalizeRetryConfig(
  config?: RetryConfig,
): Required<RetryConfig> | undefined {
  if (!config) {
    return undefined;
  }

  if (config.maxAttempts < 1) {
    throw new Error(
      `RetryConfig.maxAttempts must be at least 1, received: ${config.maxAttempts}`,
    );
  }

  return {
    maxAttempts: config.maxAttempts,
    initialDelayMs: config.initialDelayMs ?? 1000,
    maxDelayMs: config.maxDelayMs ?? 30000,
    backoffFactor: config.backoffFactor ?? 2.0,
    retryableErrors: config.retryableErrors ?? [],
  };
}
