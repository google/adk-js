/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FinishReason, FunctionCall, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {TrackingScope} from '../../src/plugins/_reflect_retry_utils.js';
import {
  ADK_HANDLE_MODEL_ERROR_TOOL_NAME,
  ReflectAndRetryModelPlugin,
  RESERVED_TOOL_CALL_ERROR_TYPE,
} from '../../src/plugins/reflect_retry_model_plugin.js';

function createMockContext(
  invocationId = 'inv-model-01',
  agentName = 'model_agent',
): Context {
  const stateStore: Record<string, unknown> = {};
  return {
    invocationId,
    agentName,
    state: {
      get: (key: string) => stateStore[key],
      set: (key: string, value: unknown) => {
        stateStore[key] = value;
      },
    },
  } as unknown as Context;
}

function createMockRequest(): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

describe('ReflectAndRetryModelPlugin', () => {
  describe('constructor and configuration', () => {
    it('should initialize with default parameters', () => {
      const plugin = new ReflectAndRetryModelPlugin();
      expect(plugin.name).toBe('reflect_retry_model_plugin');
      expect(plugin.maxRetries).toBe(3);
      expect(plugin.throwExceptionIfRetryExceeded).toBe(true);
      expect(plugin.scope).toBe(TrackingScope.INVOCATION);
      expect(plugin.onModelErrors).toEqual([
        FinishReason.MALFORMED_FUNCTION_CALL,
      ]);
    });

    it('should initialize with options object', () => {
      const plugin = new ReflectAndRetryModelPlugin({
        name: 'custom_model_retry',
        maxRetries: 5,
        throwExceptionIfRetryExceeded: false,
        trackingScope: TrackingScope.GLOBAL,
        onModelErrors: [
          FinishReason.SAFETY,
          FinishReason.MALFORMED_FUNCTION_CALL,
        ],
      });
      expect(plugin.name).toBe('custom_model_retry');
      expect(plugin.maxRetries).toBe(5);
      expect(plugin.throwExceptionIfRetryExceeded).toBe(false);
      expect(plugin.scope).toBe(TrackingScope.GLOBAL);
      expect(plugin.onModelErrors).toContain(FinishReason.SAFETY);
    });

    it('should throw error for negative maxRetries', () => {
      expect(() => new ReflectAndRetryModelPlugin({maxRetries: -1})).toThrow(
        'maxRetries must be a non-negative integer.',
      );
    });
  });

  describe('beforeModelCallback', () => {
    it('should provide the reflection tool in llmRequest.toolsDict', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const llmRequest = createMockRequest();
      const callbackContext = createMockContext();

      const result = await plugin.beforeModelCallback({
        callbackContext,
        llmRequest,
      });

      expect(result).toBeUndefined();
      expect(
        llmRequest.toolsDict[ADK_HANDLE_MODEL_ERROR_TOOL_NAME],
      ).toBeDefined();
      expect(llmRequest.toolsDict[ADK_HANDLE_MODEL_ERROR_TOOL_NAME].name).toBe(
        ADK_HANDLE_MODEL_ERROR_TOOL_NAME,
      );
    });
  });

  describe('afterModelCallback and retry flow', () => {
    it('should catch malformed function call error and return reflection retry part', async () => {
      const plugin = new ReflectAndRetryModelPlugin({maxRetries: 3});
      const callbackContext = createMockContext('inv-malformed');
      const malformedResponse: LlmResponse = {
        errorCode: 'MALFORMED_FUNCTION_CALL',
        errorMessage: 'Invalid JSON payload from model',
        finishReason: FinishReason.MALFORMED_FUNCTION_CALL,
      };

      const retryResponse = await plugin.afterModelCallback({
        callbackContext,
        llmResponse: malformedResponse,
      });

      expect(retryResponse).toBeDefined();
      expect(retryResponse!.content).toBeDefined();
      expect(retryResponse!.content!.role).toBe('model');
      expect(retryResponse!.content!.parts).toHaveLength(1);

      const part = retryResponse!.content!.parts![0];
      expect(part.functionCall).toBeDefined();
      expect(part.functionCall!.name).toBe(ADK_HANDLE_MODEL_ERROR_TOOL_NAME);
      expect(part.functionCall!.args).toBeDefined();
      expect(
        (part.functionCall!.args as Record<string, unknown>)['retry_count'],
      ).toBe(1);
    });

    it('should throw exception when model error exceeds maxRetries and throwException is true', async () => {
      const plugin = new ReflectAndRetryModelPlugin({
        maxRetries: 2,
        throwExceptionIfRetryExceeded: true,
      });
      const callbackContext = createMockContext('inv-exceed');
      const malformedResponse: LlmResponse = {
        errorCode: 'MALFORMED_FUNCTION_CALL',
        finishReason: FinishReason.MALFORMED_FUNCTION_CALL,
      };

      // 1st retry
      await plugin.afterModelCallback({
        callbackContext,
        llmResponse: malformedResponse,
      });
      // 2nd retry
      await plugin.afterModelCallback({
        callbackContext,
        llmResponse: malformedResponse,
      });

      // 3rd attempt exceeds maxRetries (2) -> throws exception
      await expect(
        plugin.afterModelCallback({
          callbackContext,
          llmResponse: malformedResponse,
        }),
      ).rejects.toThrow(
        'The model has failed consecutively 2 times and the retry limit has been exceeded.',
      );
    });

    it('should intercept reserved tool calls from the model', async () => {
      const plugin = new ReflectAndRetryModelPlugin({maxRetries: 3});
      const callbackContext = createMockContext('inv-reserved');
      const reservedResponse: LlmResponse = {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-res-1',
                name: ADK_HANDLE_MODEL_ERROR_TOOL_NAME,
                args: {},
              } as FunctionCall,
            } as Part,
          ],
        } as Content,
      };

      const retryRes = await plugin.afterModelCallback({
        callbackContext,
        llmResponse: reservedResponse,
      });

      expect(retryRes).toBeDefined();
      const part = retryRes!.content!.parts![0];
      expect(
        (part.functionCall!.args as Record<string, unknown>)['error_type'],
      ).toBe(RESERVED_TOOL_CALL_ERROR_TYPE);
    });

    it('should reset model failure count on successful turn', async () => {
      const plugin = new ReflectAndRetryModelPlugin({maxRetries: 3});
      const callbackContext = createMockContext('inv-success');

      // First failure
      await plugin.afterModelCallback({
        callbackContext,
        llmResponse: {
          errorCode: 'MALFORMED_FUNCTION_CALL',
          finishReason: FinishReason.MALFORMED_FUNCTION_CALL,
        },
      });

      // Subsequent successful response
      const successResponse: LlmResponse = {
        content: {
          role: 'model',
          parts: [{text: 'Task complete!'}],
        } as Content,
        finishReason: FinishReason.STOP,
      };

      const result = await plugin.afterModelCallback({
        callbackContext,
        llmResponse: successResponse,
      });

      expect(result).toBeUndefined();
    });
  });

  describe('adkHandleModelError reflection tool execution', () => {
    it('should return reflection guidance string', () => {
      const plugin = new ReflectAndRetryModelPlugin({maxRetries: 3});
      const output = plugin.adkHandleModelError({retryCount: 2});
      expect(output.reflection_guidance).toContain(
        'The call to the model failed.',
      );
      expect(output.reflection_guidance).toContain(
        'retry attempt **2** of **3**',
      );
    });
  });
});
