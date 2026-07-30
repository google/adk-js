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

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_JITTER = 1;

/**
 * The names a thrown value can be matched against.
 *
 * A `class MyError extends Error {}` that never assigns `this.name` reports
 * `name === 'Error'`, so the constructor name is what makes listing the class
 * itself work. A value that is not an `Error` matches nothing.
 */
function matchableNames(error: unknown): string[] {
  if (!(error instanceof Error)) {
    return [];
  }
  return [error.name, error.constructor.name];
}

/**
 * Decides whether a node that just threw should be retried.
 *
 * @param error The value the node threw.
 * @param config The node's retry config; no config means no retries.
 * @param attemptCount The 1-based number of the attempt that just failed.
 */
export function shouldRetryNode(
  error: unknown,
  config: RetryConfig | undefined,
  attemptCount: number,
): boolean {
  if (!config) {
    return false;
  }
  if (attemptCount >= (config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
    return false;
  }
  if (!config.errors) {
    return true;
  }
  const names = matchableNames(error);
  return config.errors.some((entry) =>
    names.includes(typeof entry === 'string' ? entry : entry.name),
  );
}

/**
 * Returns how long to wait before the next attempt, in milliseconds.
 *
 * @param config The node's retry config; the defaults apply when omitted.
 * @param attemptCount The 1-based number of the attempt that just failed.
 */
export function getRetryDelayMs(
  config: RetryConfig | undefined,
  attemptCount: number,
): number {
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const backoffFactor = config?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const jitter = config?.jitter ?? DEFAULT_JITTER;

  const exponent = Math.max(0, attemptCount - 1);
  const delayMs = Math.min(
    initialDelayMs * backoffFactor ** exponent,
    maxDelayMs,
  );
  if (jitter <= 0) {
    return delayMs;
  }
  const offsetMs = (Math.random() * 2 - 1) * jitter * delayMs;
  return Math.max(0, delayMs + offsetMs);
}
