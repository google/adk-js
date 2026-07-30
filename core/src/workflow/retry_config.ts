/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration for retrying a workflow node that threw.
 *
 * Delays are expressed in milliseconds (adk-python's `RetryConfig` uses
 * fractional seconds); the effective defaults are the same.
 */
export interface RetryConfig {
  /**
   * Maximum number of attempts, including the original one. `0` or `1` means
   * no retries. Defaults to 5.
   */
  maxAttempts?: number;

  /** Delay before the first retry, in milliseconds. Defaults to 1000. */
  initialDelayMs?: number;

  /** Maximum delay between retries, in milliseconds. Defaults to 60000. */
  maxDelayMs?: number;

  /**
   * Multiplier applied to the delay after each attempt. Defaults to 2.
   */
  backoffFactor?: number;

  /**
   * Randomness factor applied to the delay. Defaults to 1; use 0 to make the
   * delay deterministic.
   */
  jitter?: number;

  /**
   * The errors to retry on, given as error class names or as the error classes
   * themselves. When omitted, every error is retried.
   */
  errors?: Array<string | (new (...args: never[]) => Error)>;
}
