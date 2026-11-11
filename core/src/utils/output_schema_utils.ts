/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm} from '../models/base_llm.js';
import {isGemini} from '../models/google_llm.js';
import {isGemini2OrAbove} from './model_name.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from './variant_utils.js';

/**
 * Returns whether the model can natively accept an output schema at the same
 * time as tools, which is strictly more reliable than the prompt-based
 * `set_model_response` workaround.
 *
 * Early Access Program model names encode no numeric version, so this returns
 * `false` for them even on Vertex AI, where they do support the capability.
 * That under-reporting is a known gap.
 *
 * @param model A simple or path-based model name, or a `BaseLlm` instance.
 * @return True if the model supports an output schema alongside tools.
 */
export function canUseOutputSchemaWithTools(model: string | BaseLlm): boolean {
  const modelString = typeof model === 'string' ? model : model.model;
  const variant = isGemini(model) ? model.apiBackend : getGoogleLlmVariant();
  return (
    variant === GoogleLLMVariant.VERTEX_AI && isGemini2OrAbove(modelString)
  );
}
