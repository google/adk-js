/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
  return getBooleanEnvVar('GOOGLE_GENAI_USE_VERTEXAI') ?
      GoogleLLMVariant.VERTEX_AI :
      GoogleLLMVariant.GEMINI_API;
}

/**
 * Gets the boolean value of the given environment variable.
 *
 * @param envVar The environment variable to get the value of.
 * @return The boolean value of the environment variable.
 */
function getBooleanEnvVar(envVar: string): boolean {
  if (!process.env) {
    return false;
  }

  const envVarValue = (process.env[envVar] || '').toLowerCase();

  return ['true', '1'].includes(envVar.toLowerCase());
}
