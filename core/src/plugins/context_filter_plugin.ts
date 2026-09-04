/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {Context} from '../agents/context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {logger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Moves `splitIndex` left until function calls and responses stay paired.
 *
 * When truncating context, we must avoid keeping a `functionResponse` while
 * dropping its matching preceding `functionCall`.
 *
 * @param contents Full conversation contents in chronological order.
 * @param splitIndex Candidate split index (keep `contents.slice(splitIndex)`).
 * @returns A (possibly smaller) split index that preserves call/response pairs.
 */
function _adjustSplitIndexToAvoidOrphanedFunctionResponses(
  contents: Content[],
  splitIndex: number,
): number {
  const neededCallIds = new Set<string>();
  for (let i = contents.length - 1; i >= 0; i--) {
    const parts = contents[i].parts;
    if (parts) {
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j];
        if (part.functionResponse?.id) {
          neededCallIds.add(part.functionResponse.id);
        }
        if (part.functionCall?.id) {
          neededCallIds.delete(part.functionCall.id);
        }
      }
    }

    if (i <= splitIndex && neededCallIds.size === 0) {
      return i;
    }
  }

  return 0;
}

/**
 * Returns whether a Content object contains function responses.
 *
 * @param content The Content to inspect.
 * @returns True if any part in the content has a functionResponse.
 */
function _isFunctionResponseContent(content: Content): boolean {
  return content.parts?.some((part) => part.functionResponse != null) ?? false;
}

/**
 * Returns whether a Content object represents human user input (not tool output).
 *
 * @param content The Content to inspect.
 * @returns True if role is 'user' and content is not a function response.
 */
function _isHumanUserContent(content: Content): boolean {
  return content.role === 'user' && !_isFunctionResponseContent(content);
}

/**
 * Returns indices that begin a user-started invocation.
 *
 * An invocation begins with one or more consecutive user messages. Tool outputs
 * (function responses) have role="user" but are not considered invocation starts.
 *
 * @param contents Full conversation contents in chronological order.
 * @returns A list of indices where each index marks the beginning of an invocation.
 */
function _getInvocationStartIndices(contents: Content[]): number[] {
  const invocationStartIndices: number[] = [];
  let previousWasHumanUser = false;
  for (let i = 0; i < contents.length; i++) {
    const isHumanUser = _isHumanUserContent(contents[i]);
    if (isHumanUser && !previousWasHumanUser) {
      invocationStartIndices.push(i);
    }
    previousWasHumanUser = isHumanUser;
  }
  return invocationStartIndices;
}

/**
 * Custom filter function for manipulating or transforming Content items.
 */
export type CustomFilterFunction = (
  contents: Content[],
) => Content[] | Promise<Content[]>;

/**
 * Options for configuring {@link ContextFilterPlugin}.
 */
export interface ContextFilterPluginOptions {
  /**
   * The number of last invocations to keep. An invocation starts with one or
   * more consecutive user messages and can contain multiple model turns (e.g. tool
   * calls) until the next user message starts a new invocation.
   */
  numInvocationsToKeep?: number;

  /**
   * A function to filter or transform the context before sending to the model.
   */
  customFilter?: CustomFilterFunction;

  /**
   * The name of the plugin instance. Defaults to 'context_filter_plugin'.
   */
  name?: string;

  /**
   * The number of invocations to remove when the context exceeds the limit.
   * Must be at least 1. Defaults to 1.
   */
  removeAmount?: number;
}

/**
 * A plugin that filters the LLM context to reduce its size and sanitize sensitive data.
 *
 * Provides:
 * - Invocation windowing: retains only the most recent N invocations.
 * - Call/response pair safety: moves the split point backwards if necessary to prevent
 *   orphaned functionResponse parts.
 * - Custom filtering: hooks a custom filter function (e.g. for PII redaction or content filtering).
 * - Safe error handling: catches errors during filtering and preserves original context.
 */
export class ContextFilterPlugin extends BasePlugin {
  readonly numInvocationsToKeep?: number;
  readonly customFilter?: CustomFilterFunction;
  readonly removeAmount: number;

  /**
   * Initializes the ContextFilterPlugin.
   *
   * @param options Configuration options.
   */
  constructor(options: ContextFilterPluginOptions = {}) {
    super(options.name ?? 'context_filter_plugin');
    this.numInvocationsToKeep = options.numInvocationsToKeep;
    this.customFilter = options.customFilter;
    this.removeAmount = options.removeAmount ?? 1;

    if (this.removeAmount < 1) {
      throw new Error('removeAmount must be at least 1');
    }
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    try {
      if (!params.llmRequest.contents) {
        return;
      }

      let contents = params.llmRequest.contents;

      if (
        this.numInvocationsToKeep !== undefined &&
        this.numInvocationsToKeep !== null &&
        this.numInvocationsToKeep > 0
      ) {
        const invocationStartIndices = _getInvocationStartIndices(contents);
        if (
          invocationStartIndices.length >=
          this.numInvocationsToKeep + this.removeAmount
        ) {
          let splitIndex =
            invocationStartIndices[
              invocationStartIndices.length - this.numInvocationsToKeep
            ];

          splitIndex = _adjustSplitIndexToAvoidOrphanedFunctionResponses(
            contents,
            splitIndex,
          );
          contents = contents.slice(splitIndex);
        }
      }

      if (this.customFilter) {
        contents = await this.customFilter(contents);
      }

      params.llmRequest.contents = contents;
    } catch (error) {
      logger.error(
        `[${this.name}] Failed to reduce context for request:`,
        error,
      );
    }

    return;
  }
}
