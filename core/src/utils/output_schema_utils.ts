/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * Early Access Program model names encode no numeric version, so
 * `isGemini2OrAbove` rejects them even on Vertex AI. The Python
 * implementation accepts them; that gap lives in the shared predicate.
 *
 * @param modelString A simple or path-based model name.
 * @return True if the model supports an output schema alongside tools.
 */
export function canUseOutputSchemaWithTools(modelString: string): boolean {
  return (
    getGoogleLlmVariant() === GoogleLLMVariant.VERTEX_AI &&
    isGemini2OrAbove(modelString)
  );
}
