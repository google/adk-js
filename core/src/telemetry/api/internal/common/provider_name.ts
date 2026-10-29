/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isEnterpriseModeEnabled} from '../../../../utils/env_aware_utils.js';
import {extractModelName, isGeminiModel} from '../../../../utils/model_name.js';

const ANTHROPIC_MODEL_PATTERN = /^claude[-.]/i;

/**
 * Leading segments of a resource-path model id. They name a resource
 * collection, never a provider.
 */
const RESOURCE_COLLECTION_SEGMENTS: ReadonlySet<string> = new Set([
  'endpoints',
  'locations',
  'models',
  'projects',
  'publishers',
  'tunedmodels',
]);

/** `gen_ai.provider.name` values that renamed a Google `gen_ai.system` value. */
const PROVIDER_NAME_BY_SYSTEM_NAME: Readonly<Record<string, string>> = {
  gemini: 'gcp.gemini',
  vertex_ai: 'gcp.vertex_ai',
};

/**
 * Returns the `gen_ai.system` name of the Gemini backend in use.
 *
 * Without a `process` global (a browser or a worker) there are no environment
 * variables to select the enterprise backend.
 */
export function guessGeminiSystemName(): string {
  return typeof process !== 'undefined' && isEnterpriseModeEnabled()
    ? 'vertex_ai'
    : 'gemini';
}

function systemNameFromModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  if (isGeminiModel(model)) {
    return guessGeminiSystemName();
  }
  const modelName = extractModelName(model);
  if (ANTHROPIC_MODEL_PATTERN.test(modelName)) {
    return 'anthropic';
  }
  const separator = modelName.indexOf('/');
  if (separator > 0) {
    const provider = modelName.slice(0, separator).toLowerCase();
    if (!RESOURCE_COLLECTION_SEGMENTS.has(provider)) {
      return provider;
    }
  }
  return undefined;
}

/**
 * Returns the `gen_ai.provider.name` of the provider serving `model`.
 *
 * A `<provider>/<model>` id names its provider in the prefix. Otherwise, and
 * for Gemini models, the name follows the Gemini backend in use.
 */
export function resolveProviderName(model: string | undefined): string {
  const systemName = systemNameFromModel(model) ?? guessGeminiSystemName();
  return PROVIDER_NAME_BY_SYSTEM_NAME[systemName] ?? systemName;
}
