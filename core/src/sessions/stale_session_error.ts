/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const STALE_SESSION_ERROR_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.staleSessionError',
);

/**
 * Error thrown when a session write loses an optimistic concurrency race.
 */
export class StaleSessionError extends Error {
  readonly [STALE_SESSION_ERROR_SIGNATURE_SYMBOL] = true;

  constructor(message: string) {
    super(message);
    this.name = 'StaleSessionError';
    Object.setPrototypeOf(this, StaleSessionError.prototype);
  }
}

/**
 * Type guard for {@link StaleSessionError}.
 *
 * @param obj The value to check.
 * @returns True if obj is a {@link StaleSessionError}.
 */
export function isStaleSessionError(obj: unknown): obj is StaleSessionError {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (STALE_SESSION_ERROR_SIGNATURE_SYMBOL in obj ||
      (obj instanceof Error && obj.name === 'StaleSessionError'))
  );
}
