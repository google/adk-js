/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it} from 'vitest';
import {
  getGoogleLlmVariant,
  GoogleLLMVariant,
} from '../../src/utils/variant_utils.js';

describe('variant_utils', () => {
  describe('getGoogleLlmVariant', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return GEMINI_API by default (when env var is not set)', () => {
      delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_VERTEXAI is "true"', () => {
      process.env = {...originalEnv, 'GOOGLE_GENAI_USE_VERTEXAI': 'true'};
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_VERTEXAI is "1"', () => {
      process.env = {...originalEnv, 'GOOGLE_GENAI_USE_VERTEXAI': '1'};
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return GEMINI_API when GOOGLE_GENAI_USE_VERTEXAI is "false"', () => {
      process.env = {...originalEnv, 'GOOGLE_GENAI_USE_VERTEXAI': 'false'};
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
    });
  });
});
