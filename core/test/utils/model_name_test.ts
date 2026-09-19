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
