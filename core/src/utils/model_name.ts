/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';

const MODEL_NAME_PATTERN =
  '^projects/[^/]+/locations/[^/]+/publishers/[^/]+/models/(.+)$';

/**
 * Extract the actual model name from either simple or path-based format.
 *
 * @param modelString Either a simple model name like "gemini-2.5-pro" or
 *     a path-based model name like "projects/.../models/gemini-2.0-flash-001"
 * @return The extracted model name (e.g., "gemini-2.5-pro")
 */
export function extractModelName(modelString: string): string {
  const match = modelString.match(MODEL_NAME_PATTERN);
  if (match) {
    return match[1];
  }

  // If it's not a path-based model, return as-is (simple model name)
  return modelString;
}

/**
 * Check if the model is a Gemini model using regex patterns.
 *
 * @param modelString Either a simple model name or path - based model name
 * @return true if it's a Gemini model, false otherwise.
 */
export function isGeminiModel(modelString: string): boolean {
  const modelName = extractModelName(modelString);

  return modelName.startsWith('gemini-');
}

interface ParsedVersion {
  valid: boolean;
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(versionString: string): ParsedVersion {
  if (!/^\d+(\.\d+)*$/.test(versionString)) {
    return {valid: false, major: 0, minor: 0, patch: 0};
  }
  const parts = versionString.split('.').map((part) => parseInt(part, 10));

  return {
    valid: true,
    major: parts[0],
    minor: parts.length > 1 ? parts[1] : 0,
    patch: parts.length > 2 ? parts[2] : 0,
  };
}

/**
 * Check if the model is a Gemini 1.x model using regex patterns.
 *
 * @param modelString Either a simple model name or path - based model name
 * @return true if it's a Gemini 1.x model, false otherwise.
 */
export function isGemini1Model(modelString: string): boolean {
  const modelName = extractModelName(modelString);

  return modelName.startsWith('gemini-1');
}

/**
 * Check if the model is a Gemini 2.x model using regex patterns.
 *
 * @param modelString Either a simple model name or path - based model name
 * @return true if it's a Gemini 2.x model, false otherwise.
 */
export function isGemini2OrAbove(modelString: string): boolean {
  if (!modelString) {
    return false;
  }

  const modelName = extractModelName(modelString);

  if (!modelName.startsWith('gemini-')) {
    return false;
  }

  const versionString = modelName.slice('gemini-'.length).split('-', 1)[0];

  const parsedVersion = parseVersion(versionString);
  return parsedVersion.valid && parsedVersion.major >= 2;
}

/**
 * Check if the model is a Gemini 3.x Live model.
 *
 * Matches the whole `gemini-3.N-*live*` family, not just the `-flash-live`
 * spelling: ids such as `gemini-3.8-live` and `gemini-3.5-transcribe-live` are
 * Live models too, and they need the same realtime handling. Non-live 3.x
 * models such as `gemini-3.0-flash` are still excluded. Gemini 3.5 Live
 * Translate ids are excluded as well, mirroring adk-python's
 * `_is_gemini_3_x_live`, which handles them through a dedicated translate
 * branch instead.
 *
 * @param modelString Either a simple model name or path-based model name
 * @return true if it's a Gemini 3.x Live model, false otherwise.
 */
export function isGemini3xLive(modelString: string | undefined): boolean {
  if (!modelString) {
    return false;
  }
  const modelName = extractModelName(modelString);
  return (
    modelName.startsWith('gemini-3.') &&
    modelName.includes('-live') &&
    !isGemini35LiveTranslate(modelString)
  );
}

/**
 * Check if the model is a Gemini 3.5 Live Translate model.
 *
 * Live Translate ids contain "-live" but are translation endpoints rather
 * than conversational Live models, so they must not take the Gemini 3.x Live
 * conversational path. Mirrors adk-python's `is_gemini_3_5_live_translate`.
 *
 * @param modelString Either a simple model name or path-based model name
 * @return true if it's a Gemini 3.5 Live Translate model, false otherwise.
 */
export function isGemini35LiveTranslate(
  modelString: string | undefined,
): boolean {
  if (!modelString) {
    return false;
  }
  return extractModelName(modelString).startsWith('gemini-3.5-live-translate');
}

/**
 * Check if the model is a Gemini 3.x Live model.
 *
 * @param modelString Either a simple model name or path-based model name
 * @return true if it's a Gemini 3.x Live model, false otherwise.
 * @deprecated Renamed to {@link isGemini3xLive}, which covers every Gemini 3.x
 *   Live id rather than only those spelled `-flash-live`.
 */
export function isGemini3xFlashLive(modelString: string | undefined): boolean {
  return isGemini3xLive(modelString);
}

/**
 * Returns True when Gemini model-id validation should be bypassed.
 */
export function isGeminiModelIdCheckDisabled(): boolean {
  return getBooleanEnvVar('ADK_DISABLE_GEMINI_MODEL_ID_CHECK');
}
