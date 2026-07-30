/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, isBaseLlm} from '../models/base_llm.js';

import {isGemini2OrAbove} from './model_name.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from './variant_utils.js';

/**
 * Returns whether the model can natively accept an output schema at the same
 * time as tools.
 *
 * When it can, the request should carry the schema directly
 * (`config.responseSchema`); native structured output is strictly more
 * reliable than the prompt-based `set_model_response` workaround, which asks
 * the model to route its final answer through a synthetic function call.
 * When it cannot, callers must fall back to that workaround.
 *
 * Note that Gemini 2.0+ is recognised by numeric version alone, so Gemini
 * Early Access Program model names — which encode no numeric version — return
 * false here even on Vertex AI. That is narrower than the Python
 * implementation and is deliberate: recognising those names belongs in the
 * shared `isGemini2OrAbove` predicate, which several other call sites share.
 *
 * @param model The model name, or a resolved model instance to read it from.
 * @return True if the model supports an output schema alongside tools.
 */
export function canUseOutputSchemaWithTools(model: string | BaseLlm): boolean {
  const modelString = isBaseLlm(model) ? model.model : model;

  return (
    getGoogleLlmVariant() === GoogleLLMVariant.VERTEX_AI &&
    isGemini2OrAbove(modelString)
  );
}
