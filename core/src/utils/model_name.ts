/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
export function isGemini2Model(modelString: string): boolean {
  const modelName = extractModelName(modelString);

  return modelName.startsWith('gemini-2');
}