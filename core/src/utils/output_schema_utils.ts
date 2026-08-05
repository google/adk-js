/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isGemini2OrAbove} from './model_name.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from './variant_utils.js';

/**
 * Returns whether the model can natively accept an output schema at the same
 * time as tools, which is strictly more reliable than the prompt-based
 * `set_model_response` workaround.
 *
 * Early Access Program model names encode no numeric version, so
 * `isGemini2OrAbove` rejects them and this returns `false` for them even on
 * Vertex AI, where they do support the capability. That under-reporting is a
 * known gap in the shared version predicate, not a decision made here: it can
 * only be closed in `isGemini2OrAbove`, which every other caller shares.
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
