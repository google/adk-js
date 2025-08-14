/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Tool} from '@google/genai';

import {LlmRequest} from '../models/llm_request.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from '../utils/variant_utils.js';

import {ToolContext} from './tool_context.js';

/**
 * The base class for all tools.
 */
export abstract class BaseTool {
  /**
   * Base constructor for a tool.
   *
   * @param name The name of the tool.
   * @param description The description of the tool.
   * @param isLongRunning Whether the tool is a long running operation, which
   *     typically returns a
   * resource id first and finishes the operation later.
   */
  constructor(
      public readonly name: string,
      public readonly description: string,
      public readonly isLongRunning: boolean = false,
  ) {}

  /**
   * Gets the OpenAPI specification of this tool in the form of a
   * FunctionDeclaration.
   *
   * NOTE
   * - Required if subclass uses the default implementation of
   *   `processLlmRequest` to add function declaration to LLM request.
   * - Otherwise, can be skipped, e.g. for a built-in GoogleSearch tool for
   *   Gemini.
   *
   * @return The FunctionDeclaration of this tool, or undefined if it doesn't
   *     need to be added to LlmRequest.config.
   */
  _getDeclaration(): FunctionDeclaration|undefined {
    return undefined;
  }

  /**
   * Runs the tool with the given arguments and context.
   *
   * NOTE
   * - Required if this tool needs to run at the client side.
   * - Otherwise, can be skipped, e.g. for a built-in GoogleSearch tool for
   *   Gemini.
   *
   * @param args The LLM-filled arguments.
   * @param toolContext The context of the tool.
   *
   * @return A promise that resolves to the tool response.
   */
  abstract runAsync(args: Record<string, unknown>, toolContext: ToolContext):
      Promise<unknown>;

  /**
   * Processes the outgoing LLM request for this tool.
   *
   * Use cases:
   * - Most common use case is adding this tool to the LLM request.
   * - Some tools may just preprocess the LLM request before it's sent out.
   *
   * @param toolContext The context of the tool.
   * @param llmRequest The outgoing LLM request, mutable this method.
   */
  async processLlmRequest(toolContext: ToolContext, llmRequest: LlmRequest):
      Promise<void> {
    const functionDeclaration = this._getDeclaration();
    if (!functionDeclaration) {
      return;
    }

    llmRequest.toolsDict[this.name] = this;

    const tool = findToolWithFunctionDeclarations(llmRequest);
    if (tool) {
      if (!tool.functionDeclarations) {
        tool.functionDeclarations = [];
      }

      tool.functionDeclarations.push(functionDeclaration);
    } else {
      llmRequest.config = llmRequest.config || {};
      llmRequest.config.tools = llmRequest.config.tools || [];
      llmRequest.config.tools.push({
        functionDeclarations: [functionDeclaration],
      });
    }
  }


  /**
   * The Google API LLM variant to use.
   */
  get apiVariant() {
    return getGoogleLlmVariant();
  }
}

function findToolWithFunctionDeclarations(llmRequest: LlmRequest): Tool|
    undefined {
  return (llmRequest.config?.tools ||
          []).find(tool => 'functionDeclarations' in tool) as Tool |
      undefined;
}
