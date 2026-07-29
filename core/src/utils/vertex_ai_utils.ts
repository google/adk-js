/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';
import {logger} from './logger.js';

const ENTERPRISE_MODE_ENV_VAR = 'GOOGLE_GENAI_USE_ENTERPRISE';
const DEPRECATED_ENTERPRISE_MODE_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

/**
 * Returns whether Google GenAI enterprise mode is enabled.
 *
 * `GOOGLE_GENAI_USE_ENTERPRISE` takes precedence whenever it is set, even when
 * it is set to a falsy value. `GOOGLE_GENAI_USE_VERTEXAI` is only consulted
 * when `GOOGLE_GENAI_USE_ENTERPRISE` is absent, and using it logs a deprecation
 * warning.
 */
function isEnterpriseModeEnabled(): boolean {
  if (process.env?.[ENTERPRISE_MODE_ENV_VAR] !== undefined) {
    return getBooleanEnvVar(ENTERPRISE_MODE_ENV_VAR);
  }

  if (process.env?.[DEPRECATED_ENTERPRISE_MODE_ENV_VAR] !== undefined) {
    logger.warn(
      `${DEPRECATED_ENTERPRISE_MODE_ENV_VAR} is deprecated, please use ` +
        `${ENTERPRISE_MODE_ENV_VAR} instead`,
    );
    return getBooleanEnvVar(DEPRECATED_ENTERPRISE_MODE_ENV_VAR);
  }

  return false;
}

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
