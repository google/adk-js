/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {getExpressModeApiKey} from '../../src/utils/vertex_ai_utils.js';

describe('vertex_ai_utils', () => {
  describe('getExpressModeApiKey', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {...originalEnv};
      delete process.env['GOOGLE_GENAI_USE_ENTERPRISE'];
      delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
      delete process.env['GOOGLE_API_KEY'];
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('should throw when both project and expressModeApiKey are provided', () => {
      expect(() =>
        getExpressModeApiKey('my-project', undefined, 'my-api-key'),
      ).toThrow('Cannot specify project or location and expressModeApiKey.');
    });

    it('should throw when both location and expressModeApiKey are provided', () => {
      expect(() =>
        getExpressModeApiKey(undefined, 'us-central1', 'my-api-key'),
      ).toThrow('Cannot specify project or location and expressModeApiKey.');
    });

    it('should throw when project, location, and expressModeApiKey are all provided', () => {
      expect(() =>
        getExpressModeApiKey('my-project', 'us-central1', 'my-api-key'),
      ).toThrow();
    });

    it('should return undefined when neither enterprise mode variable is set', () => {
      process.env['GOOGLE_API_KEY'] = 'env-api-key';
      const result = getExpressModeApiKey();
      expect(result).toBeUndefined();
    });

    it('should return undefined when GOOGLE_GENAI_USE_VERTEXAI is false', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'false';
      process.env['GOOGLE_API_KEY'] = 'env-api-key';
      const result = getExpressModeApiKey();
      expect(result).toBeUndefined();
    });

    it('should return expressModeApiKey when GOOGLE_GENAI_USE_VERTEXAI is true', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      const result = getExpressModeApiKey(undefined, undefined, 'my-api-key');
      expect(result).toBe('my-api-key');
    });

    it('should return GOOGLE_API_KEY from env when GOOGLE_GENAI_USE_VERTEXAI is true and no key provided', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      process.env['GOOGLE_API_KEY'] = 'env-api-key';
      const result = getExpressModeApiKey();
      expect(result).toBe('env-api-key');
    });

    it('should return undefined when GOOGLE_GENAI_USE_VERTEXAI is true but no key available', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      const result = getExpressModeApiKey();
      expect(result).toBeUndefined();
    });

    it('should return expressModeApiKey when GOOGLE_GENAI_USE_ENTERPRISE is true', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'true';
      const result = getExpressModeApiKey(undefined, undefined, 'my-api-key');
      expect(result).toBe('my-api-key');
    });

    it('should prefer an enabled GOOGLE_GENAI_USE_ENTERPRISE over GOOGLE_GENAI_USE_VERTEXAI', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'true';
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'false';
      process.env['GOOGLE_API_KEY'] = 'env-api-key';
      const result = getExpressModeApiKey();
      expect(result).toBe('env-api-key');
    });

    it('should not fall back to GOOGLE_GENAI_USE_VERTEXAI when GOOGLE_GENAI_USE_ENTERPRISE is set but disabled', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = '';
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      process.env['GOOGLE_API_KEY'] = 'env-api-key';
      const result = getExpressModeApiKey();
      expect(result).toBeUndefined();
    });
  });
});
