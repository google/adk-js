/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';

/**
 * Validates and returns the API key for Express Mode.
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

  if (getBooleanEnvVar('GOOGLE_GENAI_USE_VERTEXAI')) {
    return expressModeApiKey || process.env.GOOGLE_API_KEY;
  }

  return undefined;
}
