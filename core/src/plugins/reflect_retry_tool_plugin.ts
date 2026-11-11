/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {BaseTool} from '../tools/base_tool.js';
import {
  REFLECT_AND_RETRY_RESPONSE_TYPE,
  resolveScopeKey,
  ScopedFailureTracker,
  ToolFailureResponse,
  TrackingScope,
} from './_reflect_retry_utils.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Options for configuring {@link ReflectAndRetryToolPlugin}.
 */
export interface ReflectAndRetryToolPluginOptions {
  /**
   * Plugin instance identifier.
   * Defaults to 'reflect_retry_tool_plugin'.
   */
  name?: string;

  /**
   * Maximum consecutive failures before giving up (0 = no retries).
   * Defaults to 3.
   */
  maxRetries?: number;

  /**
   * If true, raises the final exception when the retry limit is reached.
   * If false, returns structured retry-exceeded guidance instead.
   * Defaults to true.
   */
  throwExceptionIfRetryExceeded?: boolean;

  /**
   * Determines the lifecycle of the error tracking state.
   * Defaults to `TrackingScope.INVOCATION` (tracking per-invocation).
   */
  trackingScope?: TrackingScope;
}

/**
 * Provides self-healing, concurrent-safe error recovery for tool failures.
 *
 * This plugin intercepts tool failures, provides structured guidance to the LLM
 * for reflection and correction, and retries the operation up to a configurable
 * limit.
 *
 * **Key Features:**
 * - **Concurrency Safe:** Uses locking to safely handle parallel tool executions.
 * - **Configurable Scope:** Tracks failures per-invocation (default) or globally
 *   using the {@link TrackingScope} enum.
 * - **Extensible Scoping:** The `getScopeKey` method can be overridden to
 *   implement custom tracking logic (e.g., per-user or per-session).
 * - **Granular Tracking:** Failure counts are tracked per-tool within the defined
 *   scope. A success with one tool resets its counter without affecting others.
 * - **Custom Error Extraction:** Supports detecting errors in normal tool responses
 *   that do not throw exceptions, by overriding `extractErrorFromResult`.
 *
 * @example
 * ```typescript
 * import {ReflectAndRetryToolPlugin, TrackingScope} from '@google/adk';
 *
 * // Example 1: Track failures per invocation (default)
 * const errorPlugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
 *
 * // Example 2: Track failures globally across all turns
 * const globalPlugin = new ReflectAndRetryToolPlugin({
 *   maxRetries: 5,
 *   trackingScope: TrackingScope.GLOBAL,
 * });
 *
 * // Example 3: Do not throw exception when retry limit is exceeded
 * const softFailPlugin = new ReflectAndRetryToolPlugin({
 *   maxRetries: 3,
 *   throwExceptionIfRetryExceeded: false,
 * });
 * ```
 */
export class ReflectAndRetryToolPlugin extends BasePlugin {
  readonly maxRetries: number;
  readonly throwExceptionIfRetryExceeded: boolean;
  readonly scope: TrackingScope;
  private readonly tracker: ScopedFailureTracker;

  /**
   * Initializes the {@link ReflectAndRetryToolPlugin}.
   *
   * @param options - Configuration options for the plugin.
   */
  constructor(options: ReflectAndRetryToolPluginOptions = {}) {
    super(options.name ?? 'reflect_retry_tool_plugin');

    const retries = options.maxRetries ?? 3;
    if (retries < 0) {
      throw new Error('maxRetries must be a non-negative integer.');
    }

    this.maxRetries = retries;
    this.throwExceptionIfRetryExceeded =
      options.throwExceptionIfRetryExceeded ?? true;
    this.scope = options.trackingScope ?? TrackingScope.INVOCATION;
    this.tracker = new ScopedFailureTracker();
  }

  /**
   * Handles successful tool calls or extracts and processes errors.
   *
   * @param params - The tool callback parameters.
   * @returns An optional record containing reflection guidance if an error is
   *   detected, or undefined if the tool call was successful or the response is
   *   already a reflection message.
   */
  override async afterToolCallback({
    tool,
    toolArgs,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    if (
      result &&
      typeof result === 'object' &&
      result['response_type'] === REFLECT_AND_RETRY_RESPONSE_TYPE
    ) {
      return undefined;
    }

    const error = await this.extractErrorFromResult({
      tool,
      toolArgs,
      toolContext,
      result,
    });

    if (error != null) {
      return await this.handleToolError(tool, toolArgs, toolContext, error);
    }

    // On success, reset the failure count for this specific tool within its scope.
    await this.resetFailuresForTool(toolContext, tool.name);
    return undefined;
  }

  /**
   * Extracts an error from a successful tool result and triggers retry logic.
   *
   * This is useful when a tool call finishes without throwing an exception but
   * the result contains an error payload like `{status: 'error', message: '...'}`
   * that should be handled by the plugin.
   *
   * @param params - Tool execution context and result.
   * @returns The extracted error if any, or undefined if no error was detected.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async extractErrorFromResult(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: unknown;
  }): Promise<unknown | undefined> {
    return undefined;
  }

  /**
   * Handles tool exceptions by providing reflection guidance.
   *
   * @param params - The error callback parameters.
   * @returns An optional record containing reflection guidance for the error.
   */
  override async onToolErrorCallback({
    tool,
    toolArgs,
    toolContext,
    error,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    return await this.handleToolError(tool, toolArgs, toolContext, error);
  }

  /**
   * Central, thread-safe logic for processing tool errors.
   *
   * @param tool - The tool that was called.
   * @param toolArgs - The arguments passed to the tool.
   * @param toolContext - The context of the tool call.
   * @param error - The error to be handled.
   * @returns An optional record containing reflection guidance for the error.
   */
  protected async handleToolError(
    tool: BaseTool,
    toolArgs: Record<string, unknown>,
    toolContext: Context,
    error: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    if (this.maxRetries === 0) {
      if (this.throwExceptionIfRetryExceeded) {
        throw this.ensureException(error);
      }
      return this.getToolRetryExceedMsg(tool, toolArgs, error);
    }

    const scopeKey = this.getScopeKey(toolContext);
    const currentRetries = await this.tracker.increment(scopeKey, tool.name);

    if (currentRetries <= this.maxRetries) {
      return this.createToolReflectionResponse(
        tool,
        toolArgs,
        error,
        currentRetries,
      );
    }

    // Max Retry exceeded
    if (this.throwExceptionIfRetryExceeded) {
      throw this.ensureException(error);
    } else {
      return this.getToolRetryExceedMsg(tool, toolArgs, error);
    }
  }

  /**
   * Returns a unique key for the state tracker based on the configured scope.
   *
   * This method can be overridden in a subclass to implement custom scoping
   * logic, for example tracking failures on a per-user or per-session basis.
   *
   * @param toolContext - The tool context.
   * @returns The resolved scope key.
   */
  protected getScopeKey(toolContext: Context): string {
    return resolveScopeKey(this.scope, toolContext.invocationId);
  }

  /**
   * Atomically resets the failure count for a tool and cleans up state.
   *
   * @param toolContext - The tool context.
   * @param toolName - The name of the tool.
   */
  protected async resetFailuresForTool(
    toolContext: Context,
    toolName: string,
  ): Promise<void> {
    const scopeKey = this.getScopeKey(toolContext);
    await this.tracker.reset(scopeKey, toolName);
  }

  /**
   * Ensures the given error is an Error instance, wrapping if not.
   *
   * @param error - The error object.
   * @returns An Error instance.
   */
  protected ensureException(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Formats error details for inclusion in the reflection message.
   *
   * @param error - The error object.
   * @returns Formatted error string.
   */
  protected formatErrorDetails(error: unknown): string {
    if (error instanceof Error) {
      const name = error.name || 'Error';
      return `${name}: ${error.message}`;
    }
    return String(error);
  }

  /**
   * Generates structured reflection guidance for tool failures.
   *
   * @param tool - The tool that failed.
   * @param toolArgs - The arguments supplied to the tool.
   * @param error - The error encountered.
   * @param retryCount - The current retry count.
   * @returns The structured tool failure response record.
   */
  protected createToolReflectionResponse(
    tool: BaseTool,
    toolArgs: Record<string, unknown>,
    error: unknown,
    retryCount: number,
  ): Record<string, unknown> {
    const argsSummary = JSON.stringify(toolArgs ?? {}, null, 2);
    const errorDetails = this.formatErrorDetails(error);

    const reflectionMessage = `
The call to tool \`${tool.name}\` failed.

**Error Details:**
\`\`\`
${errorDetails}
\`\`\`

**Tool Arguments Used:**
\`\`\`json
${argsSummary}
\`\`\`

**Reflection Guidance:**
This is retry attempt **${retryCount} of ${this.maxRetries}**. Analyze the error and the arguments you provided. Do not repeat the exact same call. Consider the following before your next attempt:

1.  **Invalid Parameters**: Does the error suggest that one or more arguments are incorrect, badly formatted, or missing? Review the tool's schema and your arguments.
2.  **State or Preconditions**: Did a previous step fail or not produce the necessary state/resource for this tool to succeed?
3.  **Alternative Approach**: Is this the right tool for the job? Could another tool or a different sequence of steps achieve the goal?
4.  **Simplify the Task**: Can you break the problem down into smaller, simpler steps?
5.  **Wrong Function Name**: Does the error indicates the tool is not found? Please check again and only use available tools.

Formulate a new plan based on your analysis and try a corrected or different approach.
`.trim();

    const response: ToolFailureResponse = {
      response_type: REFLECT_AND_RETRY_RESPONSE_TYPE,
      error_type: error instanceof Error ? error.name || 'Error' : 'ToolError',
      error_details: error instanceof Error ? error.message : String(error),
      retry_count: retryCount,
      reflection_guidance: reflectionMessage,
    };

    return response;
  }

  /**
   * Generates guidance when the maximum retry limit is exceeded.
   *
   * @param tool - The tool that failed.
   * @param toolArgs - The arguments supplied to the tool.
   * @param error - The error encountered.
   * @returns The structured retry-exceeded failure response record.
   */
  protected getToolRetryExceedMsg(
    tool: BaseTool,
    toolArgs: Record<string, unknown>,
    error: unknown,
  ): Record<string, unknown> {
    const errorDetails = this.formatErrorDetails(error);
    const argsSummary = JSON.stringify(toolArgs ?? {}, null, 2);

    const reflectionMessage = `
The tool \`${tool.name}\` has failed consecutively ${this.maxRetries} times and the retry limit has been exceeded.

**Last Error:**
\`\`\`
${errorDetails}
\`\`\`

**Last Arguments Used:**
\`\`\`json
${argsSummary}
\`\`\`

**Final Instruction:**
**Do not attempt to use the \`${tool.name}\` tool again for this task.** You must now try a different approach. Acknowledge the failure and devise a new strategy, potentially using other available tools or informing the user that the task cannot be completed.
`.trim();

    const response: ToolFailureResponse = {
      response_type: REFLECT_AND_RETRY_RESPONSE_TYPE,
      error_type: error instanceof Error ? error.name || 'Error' : 'ToolError',
      error_details: error instanceof Error ? error.message : String(error),
      retry_count: this.maxRetries,
      reflection_guidance: reflectionMessage,
    };

    return response;
  }
}
