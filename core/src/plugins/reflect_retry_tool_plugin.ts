/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {BaseTool} from '../tools/base_tool.js';
import {experimental} from '../utils/experimental.js';

import {BasePlugin} from './base_plugin.js';

// Constants

/** Default value for `params.name`. */
const DEFAULT_PLUGIN_NAME = 'reflect_retry_tool_plugin';

/** Default value for `params.maxRetries`. */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Marker written to every response this plugin produces. It lets the plugin
 * recognize its own guidance objects and avoid re-processing them as new
 * errors. The value is wire-compatible with the Python ADK implementation.
 */
export const REFLECT_AND_RETRY_RESPONSE_TYPE =
  'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN';

/**
 * Scope key used when tracking failures globally (across all invocations). The
 * value is wire-compatible with the Python ADK implementation.
 */
export const GLOBAL_SCOPE_KEY = '__global_reflect_and_retry_scope__';

/** Defines the lifecycle scope for tracking tool failure counts. */
export enum TrackingScope {
  /** Failures are counted independently for each agent invocation. */
  INVOCATION = 'invocation',
  /** Failures are counted globally across all invocations and turns. */
  GLOBAL = 'global',
}

/**
 * Structured payload returned to the model when a tool fails, containing the
 * failure details and reflection guidance. This object becomes the
 * `functionResponse.response` observed by the model.
 *
 * Property names are `camelCase`, following this repository's convention. The
 * Python ADK emits the same fields in `snake_case`; only
 * {@link REFLECT_AND_RETRY_RESPONSE_TYPE} is a wire value shared with it.
 */
export interface ToolFailureResponse {
  /** Always {@link REFLECT_AND_RETRY_RESPONSE_TYPE}. */
  responseType: string;
  /** The error's class name, or `'ToolError'` for non-`Error` values. */
  errorType: string;
  /** The raw error message. */
  errorDetails: string;
  /**
   * The consecutive failure count that produced this response. For a terminal
   * retry-limit-exceeded response this is `maxRetries`, not the actual attempt
   * number that triggered it.
   */
  retryCount: number;
  /** Human-readable guidance instructing the model how to recover. */
  reflectionGuidance: string;
}

/**
 * Per-scope, per-item consecutive-failure counter.
 *
 * The outer map is keyed by scope key (e.g. an invocation id or the global
 * scope key); the inner map is keyed by tool name.
 *
 * Unlike the Python implementation, `increment`/`reset` are synchronous and use
 * no lock. In JS the event loop is single-threaded and a synchronous
 * read-modify-write has no `await` suspension point, so it is already atomic
 * with respect to concurrent tool calls; a mutex would add complexity without
 * changing behavior.
 */
class ScopedFailureTracker {
  private readonly counters = new Map<string, Map<string, number>>();

  /** Increments and returns the consecutive-failure count for an item. */
  increment(scopeKey: string, itemName: string): number {
    let scopeCounters = this.counters.get(scopeKey);
    if (!scopeCounters) {
      scopeCounters = new Map<string, number>();
      this.counters.set(scopeKey, scopeCounters);
    }
    const next = (scopeCounters.get(itemName) ?? 0) + 1;
    scopeCounters.set(itemName, next);
    return next;
  }

  /**
   * Clears the failure count for a single item, leaving other items in the
   * same scope untouched. Empty scopes are removed to avoid unbounded growth.
   */
  reset(scopeKey: string, itemName: string): void {
    const scopeCounters = this.counters.get(scopeKey);
    if (!scopeCounters) {
      return;
    }
    scopeCounters.delete(itemName);
    if (scopeCounters.size === 0) {
      this.counters.delete(scopeKey);
    }
  }

  /** Drops an entire scope, including every item counter it holds. */
  resetScope(scopeKey: string): void {
    this.counters.delete(scopeKey);
  }
}

/** Resolves the tracking scope key for the given scope and invocation. */
function resolveScopeKey(
  scope: TrackingScope,
  invocationId: string | undefined,
): string {
  if (scope === TrackingScope.INVOCATION) {
    if (!invocationId) {
      throw new Error('invocationId must be provided for INVOCATION scope');
    }
    return invocationId;
  }
  return GLOBAL_SCOPE_KEY;
}

/** Narrows an arbitrary value to something safe to index by string key. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Renders an arbitrary value as a string. Objects use `JSON.stringify` so their
 * content is preserved (`String({})` would yield the useless `'[object
 * Object]'`); everything else falls back to `String`.
 *
 * This runs inside the error handler, so it must be total: `JSON.stringify`
 * throws on circular structures (a real risk, since a tool *result* object
 * reaches here via {@link ReflectAndRetryToolPlugin.extractErrorFromResult})
 * and returns `undefined` for values it cannot represent. Either would replace
 * the tool's actual failure with a `TypeError` and lose the reflection payload.
 */
function stringifyError(error: unknown): string {
  if (!isRecord(error)) {
    return String(error);
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Ensures the given value is an `Error`. `Error` instances are returned as-is so
 * their identity is preserved when re-thrown; other values are wrapped.
 */
function ensureError(error: unknown): Error {
  return error instanceof Error ? error : new Error(stringifyError(error));
}

/** Formats the error for the human-readable body of a reflection message. */
function formatErrorDetails(error: unknown): string {
  return error instanceof Error
    ? `${error.constructor.name}: ${error.message}`
    : stringifyError(error);
}

/** Builds a {@link ToolFailureResponse} object literal. */
function buildFailureResponse(
  error: unknown,
  retryCount: number,
  reflectionGuidance: string,
): ToolFailureResponse {
  return {
    responseType: REFLECT_AND_RETRY_RESPONSE_TYPE,
    errorType: error instanceof Error ? error.constructor.name : 'ToolError',
    errorDetails:
      error instanceof Error ? error.message : stringifyError(error),
    retryCount,
    reflectionGuidance,
  };
}

/**
 * Widens a {@link ToolFailureResponse} into the plain record the plugin
 * callbacks are contractually required to return. An interface has no implicit
 * index signature and so is not assignable to `Record<string, unknown>`;
 * spreading it into a fresh object literal is, with no cast involved.
 */
function toResponseRecord(
  response: ToolFailureResponse,
): Record<string, unknown> {
  return {...response};
}

/** Generates structured reflection guidance for a recoverable tool failure. */
function createReflectionResponse(params: {
  tool: BaseTool;
  toolArgs: Record<string, unknown>;
  error: unknown;
  retryCount: number;
  maxRetries: number;
}): ToolFailureResponse {
  const {tool, toolArgs, error, retryCount, maxRetries} = params;
  const argsSummary = JSON.stringify(toolArgs, null, 2);
  const errorDetails = formatErrorDetails(error);

  const reflectionGuidance = `
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
This is retry attempt **${retryCount} of ${maxRetries}**. Analyze the error and the arguments you provided. Do not repeat the exact same call. Consider the following before your next attempt:

1.  **Invalid Parameters**: Does the error suggest that one or more arguments are incorrect, badly formatted, or missing? Review the tool's schema and your arguments.
2.  **State or Preconditions**: Did a previous step fail or not produce the necessary state/resource for this tool to succeed?
3.  **Alternative Approach**: Is this the right tool for the job? Could another tool or a different sequence of steps achieve the goal?
4.  **Simplify the Task**: Can you break the problem down into smaller, simpler steps?
5.  **Wrong Function Name**: Does the error indicates the tool is not found? Please check again and only use available tools.

Formulate a new plan based on your analysis and try a corrected or different approach.
`.trim();

  return buildFailureResponse(error, retryCount, reflectionGuidance);
}

/** Generates terminal guidance once the retry limit has been exceeded. */
function createRetryExceededResponse(params: {
  tool: BaseTool;
  toolArgs: Record<string, unknown>;
  error: unknown;
  maxRetries: number;
}): ToolFailureResponse {
  const {tool, toolArgs, error, maxRetries} = params;
  const argsSummary = JSON.stringify(toolArgs, null, 2);
  const errorDetails = formatErrorDetails(error);

  const reflectionGuidance = `
The tool \`${tool.name}\` has failed consecutively ${maxRetries} times and the retry limit has been exceeded.

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

  return buildFailureResponse(error, maxRetries, reflectionGuidance);
}

/**
 * Provides self-healing error recovery for tool failures.
 *
 * This plugin intercepts tool failures, provides structured guidance to the
 * model for reflection and correction, and retries the operation up to a
 * configurable limit.
 *
 * **Key features:**
 * - **Configurable scope:** Tracks failures per-invocation (default) or
 *   globally using the {@link TrackingScope} enum.
 * - **Granular tracking:** Failure counts are tracked per-tool within the
 *   defined scope. A success with one tool resets its counter without affecting
 *   others.
 * - **Custom error extraction:** Supports detecting errors in otherwise
 *   successful tool responses that don't throw, by overriding
 *   {@link extractErrorFromResult}.
 *
 * This class is experimental and may change in the future.
 *
 * @example
 * ```typescript
 * import {ReflectAndRetryToolPlugin, TrackingScope} from '@google/adk';
 *
 * // Retry within the current invocation, up to 3 attempts (default).
 * const plugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
 *
 * // Track failures globally across all invocations/turns.
 * const globalPlugin = new ReflectAndRetryToolPlugin({
 *   maxRetries: 5,
 *   trackingScope: TrackingScope.GLOBAL,
 * });
 *
 * // Retry, but never throw -- return terminal guidance when the cap is hit.
 * const softPlugin = new ReflectAndRetryToolPlugin({
 *   maxRetries: 3,
 *   throwExceptionIfRetryExceeded: false,
 * });
 * ```
 */
@experimental
export class ReflectAndRetryToolPlugin extends BasePlugin {
  /** Maximum consecutive failures before giving up (0 = no retries). */
  readonly maxRetries: number;
  /** Whether to re-throw the final error when the retry limit is reached. */
  readonly throwExceptionIfRetryExceeded: boolean;
  /** The lifecycle scope used for tracking failure counts. */
  readonly scope: TrackingScope;

  private readonly tracker = new ScopedFailureTracker();

  /**
   * @param params.name Plugin instance identifier. Defaults to
   *   `'reflect_retry_tool_plugin'`.
   * @param params.maxRetries Maximum consecutive failures before giving up
   *   (0 = no retries). Defaults to `3`.
   * @param params.throwExceptionIfRetryExceeded If `true` (default), re-throws
   *   the final error when the retry limit is reached; if `false`, returns
   *   terminal guidance instead.
   * @param params.trackingScope Determines the lifecycle of the failure
   *   tracking state. Defaults to {@link TrackingScope.INVOCATION}.
   */
  constructor(params?: {
    name?: string;
    maxRetries?: number;
    throwExceptionIfRetryExceeded?: boolean;
    trackingScope?: TrackingScope;
  }) {
    super(params?.name ?? DEFAULT_PLUGIN_NAME);
    const maxRetries = params?.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (maxRetries < 0) {
      throw new Error('maxRetries must be a non-negative integer.');
    }
    this.maxRetries = maxRetries;
    this.throwExceptionIfRetryExceeded =
      params?.throwExceptionIfRetryExceeded ?? true;
    this.scope = params?.trackingScope ?? TrackingScope.INVOCATION;
  }

  /**
   * Handles successful tool calls or extracts and processes errors hidden in
   * otherwise successful results.
   *
   * `result` is declared `unknown` rather than inheriting
   * `Record<string, unknown>` from {@link BasePlugin}, because that narrower
   * type does not describe what the framework actually passes:
   * `BaseTool.runAsync` returns `Promise<unknown>`, so a tool may return a
   * primitive or an array, and `handleFunctionCallList` leaves the response
   * `null` when a tool throws a non-`Error` value. Widening a parameter in an
   * override is safe, and it lets the guard below be a real type narrowing
   * instead of an untyped defensive check.
   *
   * @returns Reflection guidance if an error is detected, or `undefined` if the
   *   call succeeded or the result is already a reflection message.
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
    result: unknown;
  }): Promise<Record<string, unknown> | undefined> {
    // Never re-process our own guidance objects as new errors.
    if (
      isRecord(result) &&
      result['responseType'] === REFLECT_AND_RETRY_RESPONSE_TYPE
    ) {
      return undefined;
    }

    const error = await this.extractErrorFromResult({
      tool,
      toolArgs,
      toolContext,
      result,
    });

    if (error) {
      return toResponseRecord(
        this.handleToolError(tool, toolArgs, toolContext, error),
      );
    }

    // On success, reset the failure count for this specific tool within scope.
    this.tracker.reset(
      resolveScopeKey(this.scope, toolContext.invocationId),
      tool.name,
    );
    return undefined;
  }

  /**
   * Extracts an error from an otherwise-successful tool result.
   *
   * The base implementation always returns `undefined`. Override this to
   * trigger retry logic for results that indicate failure without throwing
   * (e.g. `{status: 'error'}`).
   *
   * The return type is `unknown` so an override can return an `Error`.
   * `Error` is an interface and therefore has no implicit index signature, so
   * it is not assignable to `Record<string, unknown>`; returning one is what
   * makes `errorType`/`errorDetails` report the real error class rather than
   * the generic `'ToolError'`. An override may still narrow either the
   * parameter or the return type.
   *
   * @returns The extracted error, or `undefined` if no error was detected.
   */
  async extractErrorFromResult(_params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: unknown;
  }): Promise<unknown> {
    return undefined;
  }

  /**
   * Drops this invocation's failure counters once the run has completed.
   *
   * Under {@link TrackingScope.INVOCATION} a scope entry is otherwise only
   * removed when a tool later succeeds, so a run that ends while a tool is
   * still failing — the model gives up, or the cap is reached with
   * `throwExceptionIfRetryExceeded: false` — leaves its counters behind for the
   * life of the process. {@link TrackingScope.GLOBAL} is deliberately untouched
   * here, since its whole purpose is to outlive the invocation.
   */
  override async afterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    if (this.scope === TrackingScope.INVOCATION) {
      this.tracker.resetScope(invocationContext.invocationId);
    }
  }

  /**
   * Handles a thrown tool exception by providing reflection guidance.
   *
   * @returns Reflection guidance for the error, or `undefined` to let the
   *   original error propagate.
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
    return toResponseRecord(
      this.handleToolError(tool, toolArgs, toolContext, error),
    );
  }

  /**
   * Central decision tree for processing a tool error. Every path either
   * returns guidance or throws, so there is no `undefined` case.
   */
  private handleToolError(
    tool: BaseTool,
    toolArgs: Record<string, unknown>,
    toolContext: Context,
    error: unknown,
  ): ToolFailureResponse {
    if (this.maxRetries === 0) {
      if (this.throwExceptionIfRetryExceeded) {
        throw ensureError(error);
      }
      return createRetryExceededResponse({
        tool,
        toolArgs,
        error,
        maxRetries: this.maxRetries,
      });
    }

    const scopeKey = resolveScopeKey(this.scope, toolContext.invocationId);
    const currentRetries = this.tracker.increment(scopeKey, tool.name);

    if (currentRetries <= this.maxRetries) {
      return createReflectionResponse({
        tool,
        toolArgs,
        error,
        retryCount: currentRetries,
        maxRetries: this.maxRetries,
      });
    }

    if (this.throwExceptionIfRetryExceeded) {
      throw ensureError(error);
    }
    return createRetryExceededResponse({
      tool,
      toolArgs,
      error,
      maxRetries: this.maxRetries,
    });
  }
}
