/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Convert any JavaScript object to a JSON-serializable string.
 *
 * @param obj The object to serialize.
 * @returns The JSON-serialized object string or '<not serializable>' if the object cannot be serialized.
 */
export function safeJsonSerialize(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch (_e: unknown) {
    return '<not serializable>';
  }
}

/**
 * Determines whether to add live request content to the `send_data` span.
 *
 * @returns false only when ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS is explicitly set to 'false' or '0'
 */
export function shouldAddRequestResponseToSpans(): boolean {
  const envValue = process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS || 'true';
  return envValue === 'true' || envValue === '1';
}
