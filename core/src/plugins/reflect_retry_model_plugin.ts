/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FinishReason, Part} from '@google/genai';
import {v4 as uuidv4} from 'uuid';
import {Context} from '../agents/context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {FunctionTool} from '../tools/function_tool.js';
import {
  REFLECT_AND_RETRY_RESPONSE_TYPE,
  resolveScopeKey,
  ScopedFailureTracker,
  TrackingScope,
} from './_reflect_retry_utils.js';
import {BasePlugin} from './base_plugin.js';

export const RESERVED_TOOL_CALL_ERROR_TYPE = 'RESERVED_TOOL_CALL';
export const ADK_HANDLE_MODEL_ERROR_TOOL_NAME = 'adk_handle_model_error';

/**
 * Options for configuring {@link ReflectAndRetryModelPlugin}.
 */
export interface ReflectAndRetryModelPluginOptions {
  /** Plugin instance identifier. Defaults to 'reflect_retry_model_plugin'. */
  name?: string;
  /** Maximum consecutive model failures before giving up (0 = no retries). Defaults to 3. */
  maxRetries?: number;
  /** If true, raises the exception when retry limit is reached. If false, returns response. Defaults to true. */
  throwExceptionIfRetryExceeded?: boolean;
  /** Determines the lifecycle of the error tracking state. Defaults to TrackingScope.INVOCATION. */
  trackingScope?: TrackingScope;
  /** A list of FinishReasons that should be treated as model errors. Defaults to [FinishReason.MALFORMED_FUNCTION_CALL]. */
  onModelErrors?: FinishReason[];
}

/**
 * Provides self-healing, concurrent-safe error recovery for model failures.
 *
 * This plugin intercepts model failures (such as `MALFORMED_FUNCTION_CALL`),
 * provides structured guidance to the LLM for reflection and correction, and
 * retries the turn up to a configurable limit.
 *
 * @example
 * ```typescript
 * import {ReflectAndRetryModelPlugin, TrackingScope} from '@google/adk';
 *
 * const modelRetryPlugin = new ReflectAndRetryModelPlugin({
 *   maxRetries: 3,
 *   trackingScope: TrackingScope.INVOCATION,
 * });
 * ```
 */
export class ReflectAndRetryModelPlugin extends BasePlugin {
  readonly maxRetries: number;
  readonly throwExceptionIfRetryExceeded: boolean;
  readonly scope: TrackingScope;
  readonly onModelErrors: FinishReason[];
  private readonly tracker: ScopedFailureTracker;

  /**
   * Initializes the {@link ReflectAndRetryModelPlugin}.
   *
   * @param options - Configuration options for the plugin.
   */
  constructor(options: ReflectAndRetryModelPluginOptions = {}) {
    super(options.name ?? 'reflect_retry_model_plugin');

    const retries = options.maxRetries ?? 3;
    if (retries < 0) {
      throw new Error('maxRetries must be a non-negative integer.');
    }

    this.maxRetries = retries;
    this.throwExceptionIfRetryExceeded =
      options.throwExceptionIfRetryExceeded ?? true;
    this.scope = options.trackingScope ?? TrackingScope.INVOCATION;
    this.onModelErrors = options.onModelErrors ?? [
      FinishReason.MALFORMED_FUNCTION_CALL,
    ];
    this.tracker = new ScopedFailureTracker();
  }

  /**
   * Internal framework reflection tool handler.
   */
  adkHandleModelError({
    retryCount,
  }: {
    responseType?: string;
    errorType?: string;
    errorDetails?: string;
    finishReason?: string;
    retryCount?: number;
  }): {reflection_guidance: string} {
    const attempt = retryCount ?? 1;
    return {
      reflection_guidance: `
The call to the model failed.

**Reflection Guidance:**
- This is retry attempt **${attempt}** of **${this.maxRetries}**
- Analyze the error and the arguments you provided. Do not repeat the exact same call.

Formulate a new plan based on your analysis and try a corrected or different approach.
`.trim(),
    };
  }

  /**
   * Checks if the model response contains an error matching `onModelErrors`.
   */
  protected checkForModelError(llmResponse: LlmResponse): boolean {
    if (!llmResponse.errorCode && !llmResponse.finishReason) {
      return false;
    }
    if (
      llmResponse.finishReason &&
      this.onModelErrors.includes(llmResponse.finishReason)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Retrieves the model name from context.
   */
  protected getModelNameFromContext(callbackContext: Context): string {
    return callbackContext.agentName || 'default_model';
  }

  /**
   * Prepares the LLM request by attaching the reflection tool.
   */
  override async beforeModelCallback({
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    this.provideReflectionTool(llmRequest);
    return undefined;
  }

  /**
   * Inspects LLM responses, intercepts model errors or reserved tool calls, and handles retries.
   */
  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    if (this.hasReservedToolCall(llmResponse)) {
      return await this.handleReservedToolCall(callbackContext, llmResponse);
    }

    if (this.checkForModelError(llmResponse)) {
      return await this.handleModelError(callbackContext, llmResponse);
    }

    const scopeKey = this.getModelScopeKey(callbackContext);
    const modelName = this.getModelNameFromContext(callbackContext);
    await this.resetModelFailureCount(scopeKey, modelName);
    return undefined;
  }

  /**
   * Provides the adk_handle_model_error tool for reflection and retries.
   */
  protected provideReflectionTool(llmRequest: LlmRequest): void {
    if (!llmRequest.toolsDict) {
      llmRequest.toolsDict = {};
    }
    llmRequest.toolsDict[ADK_HANDLE_MODEL_ERROR_TOOL_NAME] = new FunctionTool({
      name: ADK_HANDLE_MODEL_ERROR_TOOL_NAME,
      description:
        'A tool that triggers reflection. Reserved for internal framework use only. Do not call directly.',
      execute: (args) =>
        this.adkHandleModelError(
          args as {
            responseType?: string;
            errorType?: string;
            errorDetails?: string;
            finishReason?: string;
            retryCount?: number;
          },
        ),
    });
  }

  /**
   * Checks if the model response calls the reserved reflection tool.
   */
  protected hasReservedToolCall(llmResponse: LlmResponse): boolean {
    if (!llmResponse.content?.parts) return false;
    for (const part of llmResponse.content.parts) {
      if (
        part.functionCall &&
        part.functionCall.name === ADK_HANDLE_MODEL_ERROR_TOOL_NAME
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Handles direct calls to the reserved reflection tool.
   */
  protected async handleReservedToolCall(
    callbackContext: Context,
    _llmResponse: LlmResponse,
  ): Promise<LlmResponse | undefined> {
    const retryResponse = await this.handleModelRetry(
      callbackContext,
      RESERVED_TOOL_CALL_ERROR_TYPE,
      `Model attempted to call reserved tool ${ADK_HANDLE_MODEL_ERROR_TOOL_NAME} directly. This tool is reserved for framework use only. Do not call it.`,
      FinishReason.OTHER,
    );

    if (retryResponse !== undefined) {
      return retryResponse;
    }

    return {
      errorCode: RESERVED_TOOL_CALL_ERROR_TYPE,
      errorMessage:
        'Model attempted to call reserved tool and retry limit was exceeded.',
    };
  }

  /**
   * Handles detected model errors by initiating retry logic.
   */
  protected async handleModelError(
    callbackContext: Context,
    llmResponse: LlmResponse,
  ): Promise<LlmResponse | undefined> {
    const retryResponse = await this.handleModelRetry(
      callbackContext,
      llmResponse.errorCode ?? 'MODEL_ERROR',
      llmResponse.errorMessage ?? 'Model error encountered.',
      llmResponse.finishReason ?? FinishReason.OTHER,
    );

    if (retryResponse !== undefined) {
      return retryResponse;
    }

    return llmResponse;
  }

  /**
   * Tracks retry count, generates retry response, and checks against limits.
   */
  protected async handleModelRetry(
    callbackContext: Context,
    errorType?: string,
    errorDetails?: string,
    finishReason?: FinishReason,
  ): Promise<LlmResponse | undefined> {
    const scopeKey = this.getModelScopeKey(callbackContext);
    const modelName = this.getModelNameFromContext(callbackContext);
    const currentRetries = await this.incrementModelFailureCount(
      scopeKey,
      modelName,
    );

    if (currentRetries <= this.maxRetries) {
      return {
        content: {
          role: 'model',
          parts: [
            this.generateModelRetryPart(
              currentRetries,
              errorType,
              errorDetails,
              finishReason,
            ),
          ],
        } as Content,
      };
    }

    if (this.throwExceptionIfRetryExceeded) {
      throw new Error(
        `The model has failed consecutively ${this.maxRetries} times and the retry limit has been exceeded.`,
      );
    }

    return undefined;
  }

  /**
   * Generates a function call part for the model retry tool.
   */
  protected generateModelRetryPart(
    retryCount: number,
    errorType?: string,
    errorDetails?: string,
    finishReason?: FinishReason,
  ): Part {
    return {
      functionCall: {
        id: this.getModelRetryUuid(),
        name: ADK_HANDLE_MODEL_ERROR_TOOL_NAME,
        args: {
          response_type: REFLECT_AND_RETRY_RESPONSE_TYPE,
          error_type: errorType,
          error_details: errorDetails,
          finish_reason: finishReason,
          retry_count: retryCount,
        },
      },
    } as Part;
  }

  /**
   * Generates a unique ID for the model retry tool call.
   */
  protected getModelRetryUuid(): string {
    return `${ADK_HANDLE_MODEL_ERROR_TOOL_NAME}_${uuidv4()}`;
  }

  /**
   * Returns the scope key for model failure tracking.
   */
  protected getModelScopeKey(callbackContext: Context): string {
    return resolveScopeKey(this.scope, callbackContext.invocationId);
  }

  /**
   * Increment the failure count for a model within a scope.
   */
  protected async incrementModelFailureCount(
    scopeKey: string,
    itemName: string,
  ): Promise<number> {
    return await this.tracker.increment(scopeKey, itemName);
  }

  /**
   * Reset the failure count for a model within a scope.
   */
  protected async resetModelFailureCount(
    scopeKey: string,
    itemName: string,
  ): Promise<void> {
    await this.tracker.reset(scopeKey, itemName);
  }
}
