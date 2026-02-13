/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';

/**
 * The Google LLM variant to use.
 * see
 * https://google.github.io/adk-docs/get-started/quickstart/#set-up-the-model
 */
export enum GoogleLLMVariant {
  /**
   * For using credentials from Google Vertex AI
   */
  VERTEX_AI = 'VERTEX_AI',

  /**
   * For using API Key from Google AI Studio
   */
  GEMINI_API = 'GEMINI_API',
}

/**
 * Gets the Google LLM variant to use.
 */
export function getGoogleLlmVariant() {
  return getBooleanEnvVar('GOOGLE_GENAI_USE_VERTEXAI')
    ? GoogleLLMVariant.VERTEX_AI
    : GoogleLLMVariant.GEMINI_API;
}
