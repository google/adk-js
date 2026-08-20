/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isEnterpriseModeEnabled} from './env_aware_utils.js';

export const EXPRESS_MODE_UNSUPPORTED_MESSAGE =
  'Vertex AI Express Mode (expressModeApiKey / GOOGLE_API_KEY) is not ' +
  'supported: the @google-cloud/vertexai Agent Engine client cannot send an ' +
  'API key. Provide projectId and location (with Application Default ' +
  'Credentials), or inject a preconfigured client.';

/**
 * Validates and returns the API key for Express Mode.
 *
 * The key is only returned when enterprise mode is enabled via
 * `GOOGLE_GENAI_USE_ENTERPRISE` (or the deprecated
 * `GOOGLE_GENAI_USE_VERTEXAI`).
 *
 * @param project The project id.
 * @param location The location.
 * @param expressModeApiKey The API key for Express Mode.
 * @returns The resolved API key or undefined.
 */
export function getExpressModeApiKey(
  project?: string,
  location?: string,
  expressModeApiKey?: string,
): string | undefined {
  if ((project || location) && expressModeApiKey) {
    throw new Error(
      'Cannot specify project or location and expressModeApiKey. ' +
        'Either use project and location, or just the expressModeApiKey.',
    );
  }

  if (isEnterpriseModeEnabled()) {
    return expressModeApiKey || process.env.GOOGLE_API_KEY;
  }

  return undefined;
}
