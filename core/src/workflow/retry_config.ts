/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An error constructor usable in {@link RetryConfig.exceptions}.
 */
export type ErrorClass = new (...args: never[]) => Error;

/**
 * Configuration for retrying a node.
 *
 * Ported from `google/adk-python` `workflow/_retry_config.py`. Delays are
 * expressed in **seconds** (fractions allowed) to match the Python semantics
 * and keep configuration portable across runtimes. Unset fields fall back to
 * the documented defaults inside the retry utilities.
 */
export interface RetryConfig {
  /**
   * Maximum number of attempts, including the original request. If 0 or 1, it
   * means no retries. If not specified, defaults to 5.
   */
  maxAttempts?: number;

  /**
   * Initial delay before the first retry, in seconds. If not specified,
   * defaults to 1.0 second.
   */
  initialDelay?: number;

  /**
   * Maximum delay between retries, in seconds. If not specified, defaults to
   * 60.0 seconds.
   */
  maxDelay?: number;

  /**
   * Multiplier by which the delay increases after each attempt. If not
   * specified, defaults to 2.0.
   */
  backoffFactor?: number;

  /**
   * Randomness factor for the delay. If not specified, defaults to 1.0. Use 0.0
   * to remove randomness.
   */
  jitter?: number;

  /**
   * Exceptions to retry on. Accepts error class names as strings (e.g.
   * `['TypeError']`) or error classes directly (e.g. `[TypeError]`).
   * `undefined`/`null` means retry on all errors.
   */
  exceptions?: Array<string | ErrorClass> | null;
}

/**
 * Normalizes the `exceptions` field of a {@link RetryConfig} to a list of error
 * class name strings, mirroring Python's `field_validator`.
 *
 * @returns The list of class-name strings, or `undefined` to mean "retry on all
 *   errors".
 */
export function normalizeRetryExceptions(
  exceptions?: Array<string | ErrorClass> | null,
): string[] | undefined {
  if (exceptions === undefined || exceptions === null) {
    return undefined;
  }
  return exceptions.map((item) => {
    if (typeof item === 'string') {
      return item;
    }
    if (typeof item === 'function' && item.name) {
      return item.name;
    }
    throw new Error(
      `exceptions must contain error class names (string) or error classes, got: ${String(
        item,
      )}`,
    );
  });
}

/**
 * A {@link RetryConfig} whose `exceptions` filter has been normalized to error
 * class-name strings once, up front.
 *
 * Produced by {@link prepareRetryConfig} when a node accepts its config, so the
 * retry hot path neither re-normalizes on every failure nor throws on a
 * malformed config from inside the retry loop.
 */
export interface PreparedRetryConfig {
  readonly maxAttempts?: number;
  readonly initialDelay?: number;
  readonly maxDelay?: number;
  readonly backoffFactor?: number;
  readonly jitter?: number;
  /** Normalized exception names; `undefined` means retry on all errors. */
  readonly exceptions?: readonly string[];
}

/**
 * Validates and normalizes a {@link RetryConfig} once, at config-acceptance
 * time (i.e. when a node is constructed).
 *
 * Throws if `exceptions` contains a malformed entry, surfacing the
 * misconfiguration at construction rather than masking a node's real error from
 * inside the retry path.
 */
export function prepareRetryConfig(config: RetryConfig): PreparedRetryConfig {
  return {
    maxAttempts: config.maxAttempts,
    initialDelay: config.initialDelay,
    maxDelay: config.maxDelay,
    backoffFactor: config.backoffFactor,
    jitter: config.jitter,
    exceptions: normalizeRetryExceptions(config.exceptions),
  };
}
