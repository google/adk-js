/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structured error result returned by BigQuery tools on failure.
 */
export interface BigQueryToolErrorResult {
  status: 'ERROR';
  error_details: string;
}

/**
 * Returns a readable message for any thrown value. Plain objects thrown by
 * SDKs or HTTP clients keep their `message`, or are serialized as JSON, so the
 * result is never `'[object Object]'`.
 */
function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
    try {
      const json = JSON.stringify(error);
      if (json !== undefined) {
        return json;
      }
    } catch {
      // Fall through to String() for values that JSON cannot serialize.
    }
  }
  return String(error);
}

/**
 * Converts a thrown value into the structured error result returned to the
 * model.
 */
export function toBigQueryToolErrorResult(
  error: unknown,
): BigQueryToolErrorResult {
  return {status: 'ERROR', error_details: getErrorMessage(error)};
}
