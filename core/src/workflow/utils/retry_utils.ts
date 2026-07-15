/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {RetryConfig, normalizeRetryConfig} from '../retry_config.js';

/**
 * Sleeps for a specified number of milliseconds unless the abort signal fires.
 * @param ms Delay in milliseconds.
 * @param abortSignal Optional AbortSignal to cancel sleeping early.
 */
async function sleepWithSignal(
  ms: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) {
    throw new Error('Aborted before retry delay.');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted during retry delay.'));
    };
    abortSignal?.addEventListener('abort', onAbort);
  });
}

/**
 * Checks whether an error is retryable according to the RetryConfig.
 * @param error The error thrown during execution.
 * @param retryableErrors Array of Error constructors, strings, or RegExps.
 */
function isErrorRetryable(
  error: unknown,
  retryableErrors: Required<RetryConfig>['retryableErrors'],
): boolean {
  if (!retryableErrors || retryableErrors.length === 0) {
    return true;
  }

  const errObj =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : undefined;
  const errMsg =
    errObj && typeof errObj.message === 'string' ? errObj.message : undefined;

  return retryableErrors.some((matcher) => {
    if (typeof matcher === 'string') {
      return errMsg && errMsg.includes(matcher);
    }
    if (matcher instanceof RegExp) {
      return errMsg && matcher.test(errMsg);
    }
    if (typeof matcher === 'function' && error instanceof matcher) {
      return true;
    }
    return false;
  });
}

/**
 * Wraps an async generator with retry logic according to the provided RetryConfig.
 * If the generator throws a retryable error mid-stream or during start, it will back off and retry from the beginning.
 *
 * @param generatorFactory A factory function that creates a fresh AsyncGenerator for each attempt.
 * @param retryConfig Optional RetryConfig or undefined (if undefined, runs once without retrying).
 * @param abortSignal Optional AbortSignal to halt retries upon cancellation.
 */
export async function* runWithRetry<TOutput = unknown>(
  generatorFactory: () => AsyncGenerator<Event, TOutput, unknown>,
  retryConfig?: RetryConfig,
  abortSignal?: AbortSignal,
): AsyncGenerator<Event, TOutput, unknown> {
  const config = normalizeRetryConfig(retryConfig);
  if (!config || config.maxAttempts <= 1) {
    return yield* generatorFactory();
  }

  let attempt = 1;
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error('Execution aborted before attempt.');
    }

    const generator = generatorFactory();
    try {
      const result = yield* generator;
      return result;
    } catch (error: unknown) {
      if (
        attempt >= config.maxAttempts ||
        !isErrorRetryable(error, config.retryableErrors) ||
        abortSignal?.aborted
      ) {
        throw error;
      }

      const delayMs = Math.min(
        config.initialDelayMs * Math.pow(config.backoffFactor, attempt - 1),
        config.maxDelayMs,
      );
      await sleepWithSignal(delayMs, abortSignal);
      attempt++;
    }
  }
}
