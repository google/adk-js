/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleLLMVariant} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {getGoogleLlmVariant} from '../../src/utils/variant_utils.js';

describe('variant_utils', () => {
  describe('getGoogleLlmVariant', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {...originalEnv};
      delete process.env['GOOGLE_GENAI_USE_ENTERPRISE'];
      delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('should return GEMINI_API by default (when env var is not set)', () => {
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_VERTEXAI is "true"', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_VERTEXAI is "1"', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = '1';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return GEMINI_API when GOOGLE_GENAI_USE_VERTEXAI is "false"', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'false';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_ENTERPRISE is "true"', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'true';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return GEMINI_API when GOOGLE_GENAI_USE_ENTERPRISE is "false" and GOOGLE_GENAI_USE_VERTEXAI is "true"', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'false';
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
    });
  });
});
