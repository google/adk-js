/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiError} from '@google/genai';

/**
 * Normalizes a candidate error classification by trimming strings and
 * stringifying finite numbers.
 *
 * @param value The candidate classification value.
 * @returns The non-empty trimmed classification string, or undefined if invalid.
 */
export function normalizeErrorClassification(
  value: unknown,
): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

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
      const customErrorType =
        normalizeErrorClassification(errorObject.errorType) ??
        normalizeErrorClassification(errorObject.error_type);
      if (customErrorType !== undefined) {
        return customErrorType;
      }
      if (error instanceof ApiError) {
        const apiStatus = normalizeErrorClassification(error.status);
        if (apiStatus !== undefined) {
          return apiStatus;
        }
      }
      const constructorName = normalizeErrorClassification(
        errorObject.constructor?.name,
      );
      if (constructorName !== undefined) {
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
 * error type or error code field is copied to telemetry; the payload itself is
 * never used as the error classification.
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
    return (
      normalizeErrorClassification(response.errorType) ??
      normalizeErrorClassification(response.error_type) ??
      normalizeErrorClassification(response.errorCode) ??
      normalizeErrorClassification(response.error_code)
    );
  } catch {
    // Telemetry should not change tool behavior if a custom response object
    // throws when its fields are inspected.
    return undefined;
  }
}
