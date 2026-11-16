/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isGemini2OrAbove,
  isGemini35LiveTranslate,
  isGemini3xFlashLive,
  isGemini3xLive,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  extractModelName,
  getGeminiMajorVersion,
  isGemini1Model,
  isGeminiModel,
} from '../../src/utils/model_name.js';

const MODEL_PATH_PREFIX =
  'projects/my-project/locations/us-central1/publishers/google/models/';

describe('isGemini2OrAbove', () => {
  describe('valid models', () => {
    const validModels = [
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-3-pro-image-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash-image',
      'gemini-2.5-flash',
      'gemini-2.5-flash-preview-09-2025',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash-lite-preview-09-2025',
      'gemini-2.0-flash-001',
      'gemini-2.0-flash-lite-001',
    ];

    for (const model of validModels) {
      it(`should return true for model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(true);
      });
    }
  });

  describe('invalid models', () => {
    const invalidModels = [
      'gemini-live-2.5-flash-native-audio',
      'veo-3.1-generate-001',
      'veo-3.0-fast-generate-001',
      'imagen-4.0-ultra-generate-001',
      'imagen-3.0-generate-001',
      'deepseek-ocr-maas',
      'kimi-k2-thinking-maas',
      'llama-4-scout-17b-16e-instruct-maas',
      'minimax-m2-maas',
      'gpt-oss-120b-maas',
      'qwen3-next-80b-a3b-instruct-maas',
      'gemini-1.5-pro',
      'gemini-1.0-pro',
    ];

    for (const model of invalidModels) {
      it(`should return false for model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(false);
      });
    }
  });
});

describe('isGemini3xLive', () => {
  it('should return true for valid Gemini 3.x Flash Live models', () => {
    expect(isGemini3xLive('gemini-3.1-flash-live')).toBe(true);
    expect(isGemini3xLive('gemini-3.1-flash-live-preview')).toBe(true);
    expect(isGemini3xLive('gemini-3.5-flash-live')).toBe(true);
    expect(isGemini3xLive('gemini-3.5-flash-live-preview')).toBe(true);
    expect(
      isGemini3xLive(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.1-flash-live-001',
      ),
    ).toBe(true);
    expect(
      isGemini3xLive(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.5-flash-live-001',
      ),
    ).toBe(true);
  });

  it('should return true for Live models not spelled "-flash-live"', () => {
    // These are advertised with bidiGenerateContent support but were treated
    // as non-3.x, so their audio went to the legacy media field.
    expect(isGemini3xLive('gemini-3.8-live')).toBe(true);
    expect(isGemini3xLive('gemini-3.8-live-extended-thinking')).toBe(true);
    expect(isGemini3xLive('gemini-3.5-transcribe-live')).toBe(true);
    expect(
      isGemini3xLive(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.8-live',
      ),
    ).toBe(true);
  });

  it('should return false for Gemini 3.5 Live Translate models', () => {
    // adk-python pins the same exclusion: Live Translate is a translation
    // endpoint, not a conversational Live model (test_model_name_utils.py
    // asserts `_is_gemini_3_x_live('gemini-3.5-live-translate') is False`).
    expect(isGemini3xLive('gemini-3.5-live-translate')).toBe(false);
    expect(isGemini3xLive('gemini-3.5-live-translate-preview')).toBe(false);
    expect(
      isGemini3xLive(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.5-live-translate-preview',
      ),
    ).toBe(false);
  });

  it('should return false for other models', () => {
    expect(isGemini3xLive('gemini-2.5-flash')).toBe(false);
    expect(isGemini3xLive('gemini-3.0-flash')).toBe(false);
    expect(isGemini3xLive('gemini-3-flash-preview')).toBe(false);
    expect(isGemini3xLive('gemini-3.0-pro')).toBe(false);
    expect(isGemini3xLive(undefined)).toBe(false);
    expect(isGemini3xLive('')).toBe(false);
  });
});

describe('isGemini3xFlashLive (deprecated alias)', () => {
  it('should behave identically to isGemini3xLive', () => {
    for (const model of [
      'gemini-3.1-flash-live-preview',
      'gemini-3.8-live',
      'gemini-3.0-flash',
      'gemini-2.5-flash',
      '',
      undefined,
    ]) {
      expect(isGemini3xFlashLive(model)).toBe(isGemini3xLive(model));
    }
  });
});

describe('isGemini35LiveTranslate', () => {
  it('should return true for Live Translate ids', () => {
    expect(isGemini35LiveTranslate('gemini-3.5-live-translate')).toBe(true);
    expect(isGemini35LiveTranslate('gemini-3.5-live-translate-preview')).toBe(
      true,
    );
    expect(
      isGemini35LiveTranslate(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.5-live-translate-preview',
      ),
    ).toBe(true);
  });

  it('should return false for other models', () => {
    expect(isGemini35LiveTranslate('gemini-3.8-live')).toBe(false);
    expect(isGemini35LiveTranslate('gemini-3.5-flash-live')).toBe(false);
    expect(isGemini35LiveTranslate(undefined)).toBe(false);
    expect(isGemini35LiveTranslate('')).toBe(false);
  });
});

describe('getGeminiMajorVersion', () => {
  it.each([
    ['gemini-2.5-flash', 2],
    ['gemini-3-pro-preview', 3],
    ['gemini-3.1-flash-live-preview', 3],
    ['gemini-1.5-pro', 1],
    ['projects/p/locations/l/publishers/google/models/gemini-2.0-flash-001', 2],
  ])('returns the major version of %s', (model, major) => {
    expect(getGeminiMajorVersion(model)).toBe(major);
  });

  it.each([
    'gemini-flash-latest',
    'gemini-live-2.5-flash-native-audio',
    'projects/123/locations/us-central1/endpoints/456',
    'claude-sonnet',
    '',
    undefined,
  ])('returns undefined for %s', (model) => {
    expect(getGeminiMajorVersion(model)).toBeUndefined();
  });
});

describe('extractModelName', () => {
  it.each([
    'gemini-2.5-pro',
    'gemini-1.5-flash',
    'gemini-1.0-pro',
    'claude-3-sonnet',
    'gpt-4',
  ])('returns the simple name %s unchanged', (model) => {
    expect(extractModelName(model)).toBe(model);
  });

  it.each([
    [
      'projects/12345/locations/us-central1/publishers/google/models/gemini-2.0-flash-001',
      'gemini-2.0-flash-001',
    ],
    [
      'projects/12345/locations/us-east1/publishers/google/models/gemini-1.5-pro-preview',
      'gemini-1.5-pro-preview',
    ],
    [
      'projects/test-project/locations/europe-west1/publishers/google/models/claude-3-sonnet',
      'claude-3-sonnet',
    ],
  ])('returns the last segment of the full model path %s', (path, name) => {
    expect(extractModelName(path)).toBe(name);
  });

  it.each([
    'projects/invalid/path/format',
    'invalid/path/format',
    'projects/123/locations/us-central1/models/gemini-2.0-flash',
    'projects/123/publishers/google/models/gemini-2.0-flash',
    'projects/123/locations/us-central1/publishers/google/gemini-2.0-flash',
  ])('returns the malformed path %s unchanged', (path) => {
    expect(extractModelName(path)).toBe(path);
  });

  it('returns an empty string for an empty string', () => {
    expect(extractModelName('')).toBe('');
  });

  it('accepts digits and hyphens in the project and location segments', () => {
    expect(
      extractModelName(
        'projects/123456789/locations/us-central1/publishers/google/models/gemini-2.0-flash-001',
      ),
    ).toBe('gemini-2.0-flash-001');
    expect(
      extractModelName(
        'projects/my-test-project/locations/us-central1/publishers/google/models/gemini-1.5-pro',
      ),
    ).toBe('gemini-1.5-pro');
  });
});

describe('isGeminiModel', () => {
  it.each([
    ['gemini-2.5-pro', true],
    ['gemini-1.5-flash', true],
    ['gemini-1.0-pro', true],
    ['gemini-2.0-flash-001', true],
    ['claude-3-sonnet', false],
    ['gpt-4', false],
    ['llama-2', false],
  ])('classifies the simple name %s as %s', (model, expected) => {
    expect(isGeminiModel(model)).toBe(expected);
  });

  it.each([
    [`${MODEL_PATH_PREFIX}gemini-2.0-flash-001`, true],
    [`${MODEL_PATH_PREFIX}gemini-1.5-pro-preview`, true],
    [`${MODEL_PATH_PREFIX}claude-3-sonnet`, false],
  ])('classifies the full model path %s as %s', (model, expected) => {
    expect(isGeminiModel(model)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'my-gemini-model',
    'claude-gemini-hybrid',
    'projects/my-project/locations/us-central1/publishers/gemini/models/claude-3-sonnet',
    'gemini',
    'gemini_1_5_flash',
  ])('returns false for %s', (model) => {
    expect(isGeminiModel(model)).toBe(false);
  });

  it('matches the gemini- prefix case-sensitively', () => {
    expect(isGeminiModel('Gemini-2.5-pro')).toBe(false);
    expect(isGeminiModel('GEMINI-2.5-pro')).toBe(false);
    expect(isGeminiModel('gemini-2.5-PRO')).toBe(true);
  });
});

describe('isGemini1Model', () => {
  it.each([
    ['gemini-1.5-flash', true],
    ['gemini-1.0-pro', true],
    ['gemini-1.5-pro-preview', true],
    ['gemini-1.9-experimental', true],
    ['gemini-2.0-flash', false],
    ['gemini-2.5-pro', false],
    ['gemini-10.0-pro', false],
    ['claude-3-sonnet', false],
  ])('classifies the simple name %s as %s', (model, expected) => {
    expect(isGemini1Model(model)).toBe(expected);
  });

  it.each([
    [`${MODEL_PATH_PREFIX}gemini-1.5-flash-001`, true],
    [`${MODEL_PATH_PREFIX}gemini-1.0-pro-preview`, true],
    [`${MODEL_PATH_PREFIX}gemini-2.0-flash-001`, false],
    [`${MODEL_PATH_PREFIX}gemini-10.0-pro`, false],
  ])('classifies the full model path %s as %s', (model, expected) => {
    expect(isGemini1Model(model)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'my-gemini-1.5-model',
    'custom-gemini-1.5-flash',
    'gemini-1',
    'gemini-1-pro',
    'gemini-1.',
  ])('returns false for %s', (model) => {
    expect(isGemini1Model(model)).toBe(false);
  });
});

describe('isGemini2OrAbove with path-based and malformed names', () => {
  it.each([
    [`${MODEL_PATH_PREFIX}gemini-2.0-flash-001`, true],
    [`${MODEL_PATH_PREFIX}gemini-2.5-pro-preview`, true],
    [`${MODEL_PATH_PREFIX}gemini-3.0-pro`, true],
    [`${MODEL_PATH_PREFIX}gemini-1.5-flash-001`, false],
  ])('classifies the full model path %s as %s', (model, expected) => {
    expect(isGemini2OrAbove(model)).toBe(expected);
  });

  it.each(['gemini-2', 'gemini-2-pro', 'gemini-3.0-pro'])(
    'returns true for %s',
    (model) => {
      expect(isGemini2OrAbove(model)).toBe(true);
    },
  );

  it.each([
    undefined,
    '',
    'my-gemini-2.5-model',
    'custom-gemini-2.5-flash',
    'gemini-2.',
    'gemini-0.9-test',
    'gemini-one',
  ])('returns false for %s', (model) => {
    expect(isGemini2OrAbove(model)).toBe(false);
  });
});

describe('model name predicates together', () => {
  it.each([
    'gemini-1.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-pro',
    `${MODEL_PATH_PREFIX}gemini-1.5-pro`,
    `${MODEL_PATH_PREFIX}gemini-2.0-flash`,
  ])('puts %s in exactly one Gemini generation', (model) => {
    expect(isGeminiModel(model)).toBe(true);
    expect(isGemini1Model(model)).not.toBe(isGemini2OrAbove(model));
  });

  it.each(['claude-3-sonnet', 'gpt-4', `${MODEL_PATH_PREFIX}claude-3-sonnet`])(
    'puts %s in no Gemini generation',
    (model) => {
      expect(isGeminiModel(model)).toBe(false);
      expect(isGemini1Model(model)).toBe(false);
      expect(isGemini2OrAbove(model)).toBe(false);
    },
  );

  it.each([
    'gemini-1.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-pro',
    'claude-3-sonnet',
  ])('classifies %s and its full model path the same way', (model) => {
    const path = `${MODEL_PATH_PREFIX}${model}`;

    expect(isGeminiModel(path)).toBe(isGeminiModel(model));
    expect(isGemini1Model(path)).toBe(isGemini1Model(model));
    expect(isGemini2OrAbove(path)).toBe(isGemini2OrAbove(model));
  });
});
