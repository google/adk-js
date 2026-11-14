/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FetchFunction} from '../telemetry/api/instrumentation.js';

/**
 * Largest delay `setTimeout` accepts. A larger delay overflows the signed
 * 32-bit timer value and fires at once.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Options for {@link fetchWithTimeout}. */
export interface FetchWithTimeoutOptions {
  /** Maximum time to wait for the response headers, in milliseconds. */
  timeoutMs: number;
  /**
   * The `fetch` that sends the request. Defaults to the global `fetch`, read
   * at each call.
   */
  fetchImpl?: FetchFunction;
}

/**
 * Returns a `fetch` that aborts a request whose response headers do not arrive
 * within `timeoutMs`.
 *
 * The timer stops when the wrapped `fetch` settles, so the time to read a
 * response body, a stream included, is not bounded. An abort signal the caller
 * passes still cancels the request.
 */
export function fetchWithTimeout(
  options: FetchWithTimeoutOptions,
): FetchFunction {
  const {timeoutMs, fetchImpl} = options;
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new Error(`Request timed out after ${timeoutMs} ms.`)),
      Math.min(timeoutMs, MAX_TIMER_DELAY_MS),
    );
    try {
      return await (fetchImpl ?? globalThis.fetch)(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
