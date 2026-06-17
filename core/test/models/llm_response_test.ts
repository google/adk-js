/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FinishReason, GenerateContentResponse} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createLlmResponse} from '../../src/models/llm_response.js';

function makeResponse(
  overrides: Partial<GenerateContentResponse>,
): GenerateContentResponse {
  return overrides as GenerateContentResponse;
}

describe('createLlmResponse', () => {
  describe('happy path — candidate with content parts', () => {
    it('returns content from the first candidate', () => {
      const content = {parts: [{text: 'hello'}], role: 'model'};
      const response = makeResponse({
        candidates: [{content, finishReason: FinishReason.STOP}],
      });
      const result = createLlmResponse(response);
      expect(result.content).toBe(content);
    });

    it('includes groundingMetadata when present', () => {
      const groundingMetadata = {groundingChunks: []};
      const response = makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'hi'}], role: 'model'},
            groundingMetadata,
          },
        ],
      });
      const result = createLlmResponse(response);
      expect(result.groundingMetadata).toBe(groundingMetadata);
    });

    it('includes citationMetadata when present', () => {
      const citationMetadata = {citations: []};
      const response = makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'hi'}], role: 'model'},
            citationMetadata,
          },
        ],
      });
      const result = createLlmResponse(response);
      expect(result.citationMetadata).toBe(citationMetadata);
    });

    it('includes usageMetadata when present', () => {
      const usageMetadata = {totalTokenCount: 42};
      const response = makeResponse({
        candidates: [{content: {parts: [{text: 'hi'}], role: 'model'}}],
        usageMetadata,
      });
      const result = createLlmResponse(response);
      expect(result.usageMetadata).toBe(usageMetadata);
    });

    it('includes finishReason from the first candidate', () => {
      const response = makeResponse({
        candidates: [
          {
            content: {parts: [{text: 'hi'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      });
      const result = createLlmResponse(response);
      expect(result.finishReason).toBe(FinishReason.STOP);
    });

    it('uses only the first candidate when multiple are present', () => {
      const first = {parts: [{text: 'first'}], role: 'model'};
      const second = {parts: [{text: 'second'}], role: 'model'};
      const response = makeResponse({
        candidates: [{content: first}, {content: second}],
      });
      const result = createLlmResponse(response);
      expect(result.content).toBe(first);
    });

    it('does not set errorCode or errorMessage', () => {
      const response = makeResponse({
        candidates: [{content: {parts: [{text: 'ok'}], role: 'model'}}],
      });
      const result = createLlmResponse(response);
      expect(result.errorCode).toBeUndefined();
      expect(result.errorMessage).toBeUndefined();
    });
  });

  describe('candidate present but no content parts', () => {
    it('returns errorCode from finishReason when candidate has no content', () => {
      const response = makeResponse({
        candidates: [{finishReason: FinishReason.SAFETY}],
      });
      const result = createLlmResponse(response);
      expect(result.errorCode).toBe(FinishReason.SAFETY);
    });

    it('returns errorCode when candidate content has empty parts array', () => {
      const response = makeResponse({
        candidates: [
          {
            content: {parts: [], role: 'model'},
            finishReason: FinishReason.MAX_TOKENS,
            finishMessage: 'max tokens reached',
          },
        ],
      });
      const result = createLlmResponse(response);
      expect(result.errorCode).toBe(FinishReason.MAX_TOKENS);
      expect(result.errorMessage).toBe('max tokens reached');
    });

    it('includes usageMetadata in the error response', () => {
      const usageMetadata = {totalTokenCount: 10};
      const response = makeResponse({
        candidates: [{finishReason: FinishReason.SAFETY}],
        usageMetadata,
      });
      const result = createLlmResponse(response);
      expect(result.usageMetadata).toBe(usageMetadata);
    });

    it('does not set content', () => {
      const response = makeResponse({
        candidates: [{finishReason: FinishReason.SAFETY}],
      });
      const result = createLlmResponse(response);
      expect(result.content).toBeUndefined();
    });
  });

  describe('prompt feedback block', () => {
    it('returns blockReason as errorCode', () => {
      const response = makeResponse({
        promptFeedback: {
          blockReason: 'SAFETY',
          blockReasonMessage: 'blocked by safety',
        },
      });
      const result = createLlmResponse(response);
      expect(result.errorCode).toBe('SAFETY');
    });

    it('returns blockReasonMessage as errorMessage', () => {
      const response = makeResponse({
        promptFeedback: {
          blockReason: 'OTHER',
          blockReasonMessage: 'other reason',
        },
      });
      const result = createLlmResponse(response);
      expect(result.errorMessage).toBe('other reason');
    });

    it('includes usageMetadata in the prompt feedback response', () => {
      const usageMetadata = {totalTokenCount: 5};
      const response = makeResponse({
        promptFeedback: {blockReason: 'SAFETY', blockReasonMessage: ''},
        usageMetadata,
      });
      const result = createLlmResponse(response);
      expect(result.usageMetadata).toBe(usageMetadata);
    });

    it('does not set content', () => {
      const response = makeResponse({
        promptFeedback: {blockReason: 'SAFETY', blockReasonMessage: ''},
      });
      const result = createLlmResponse(response);
      expect(result.content).toBeUndefined();
    });
  });

  describe('unknown fallback', () => {
    it('returns UNKNOWN_ERROR code when no candidates or promptFeedback', () => {
      const result = createLlmResponse(makeResponse({}));
      expect(result.errorCode).toBe('UNKNOWN_ERROR');
    });

    it('returns the unknown error message', () => {
      const result = createLlmResponse(makeResponse({}));
      expect(result.errorMessage).toBe('Unknown error.');
    });

    it('includes usageMetadata in the fallback response', () => {
      const usageMetadata = {totalTokenCount: 0};
      const result = createLlmResponse(makeResponse({usageMetadata}));
      expect(result.usageMetadata).toBe(usageMetadata);
    });

    it('does not set content', () => {
      const result = createLlmResponse(makeResponse({}));
      expect(result.content).toBeUndefined();
    });

    it('returns UNKNOWN_ERROR when candidates array is empty', () => {
      const result = createLlmResponse(makeResponse({candidates: []}));
      expect(result.errorCode).toBe('UNKNOWN_ERROR');
    });
  });
});
