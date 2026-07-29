/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';

/**
 * Error message for services that resolve an Express Mode API key but cannot
 * pass it to the Agent Engine client.
 *
 * The `Client` exported by `@google-cloud/vertexai` only accepts `project`,
 * `location` and `apiEndpoint`, and always authenticates with Application
 * Default Credentials, so an API key can never reach the wire. Services throw
 * this instead of building a client that would silently drop the key.
 */
export const EXPRESS_MODE_UNSUPPORTED_MESSAGE =
  'Vertex AI Express Mode (expressModeApiKey / GOOGLE_API_KEY) is not ' +
  'supported by the Agent Engine client: the @google-cloud/vertexai Client ' +
  'constructor only accepts project, location and apiEndpoint, so the API ' +
  'key cannot be sent. Provide projectId and location (with Application ' +
  'Default Credentials), or inject a preconfigured client.';

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
