/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiError} from '@google/genai';

/**
 * Resolves a stable error classification suitable for the OpenTelemetry
 * `error.type` attribute without using the potentially sensitive error message.
 *
 * @param error The thrown value.
 * @returns The explicit ADK error type, GenAI API status, or error class name.
 */
export function resolveErrorType(error: unknown): string {
  if (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function')
  ) {
    try {
      const errorObject = error as {
        errorType?: unknown;
        error_type?: unknown;
        constructor?: {name?: unknown};
      };
      const customErrorType = errorObject.errorType ?? errorObject.error_type;
      if (
        typeof customErrorType === 'string' ||
        typeof customErrorType === 'number'
      ) {
        return String(customErrorType);
      }
      if (error instanceof ApiError) {
        return String(error.status);
      }
      const constructorName = errorObject.constructor?.name;
      if (typeof constructorName === 'string' && constructorName.length > 0) {
        return constructorName;
      }
    } catch {
      // A hostile thrown object (for example, a Proxy with throwing getters)
      // must not replace the original tool error with a telemetry error.
    }
  }

  return typeof error;
}

/**
 * Gets an explicitly reported error type from a tool response object.
 *
 * Tools may return an error payload instead of throwing. Only the dedicated
 * error type field is copied to telemetry; the payload itself is never used as
 * the error classification.
 */
export function getToolResponseErrorType(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }

  try {
    if (!Object.hasOwn(result, 'error')) {
      return undefined;
    }
    const response = result as Record<string, unknown>;
    const errorType = response.errorType ?? response.error_type;
    return typeof errorType === 'string' ? errorType : undefined;
  } catch {
    // Telemetry should not change tool behavior if a custom response object
    // throws when its fields are inspected.
    return undefined;
  }
}
