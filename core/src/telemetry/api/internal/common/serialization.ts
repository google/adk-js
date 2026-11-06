/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getEnvVar} from '../../../../utils/env_aware_utils.js';

/**
 * Convert any JavaScript object to a JSON-serializable string.
 *
 * @param obj The object to serialize.
 * @returns The JSON-serialized object string or '<not serializable>' if the object cannot be serialized.
 */
export function safeJsonSerialize(obj: unknown): string {
  try {
    return JSON.stringify(obj, (_key, value: unknown) =>
      typeof value === 'bigint' ? '<not serializable>' : value,
    );
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
  const envValue = getEnvVar('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS') || 'true';
  return envValue === 'true' || envValue === '1';
}
