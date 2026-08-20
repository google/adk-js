/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Tool} from '@google/genai';

import {LlmRequest} from '../models/llm_request.js';
import {getGoogleLlmVariant} from '../utils/variant_utils.js';

import {Context} from '../agents/context.js';

/**
 * The parameters for `runAsync`.
 */
export interface RunAsyncToolRequest {
  args: Record<string, unknown>;
  toolContext: Context;
}

/**
 * The parameters for `processLlmRequest`.
 */
export interface ToolProcessLlmRequest {
  toolContext: Context;
  llmRequest: LlmRequest;
}

/**
 * Parameters for the BaseTool constructor.
 */
export interface BaseToolParams {
  name: string;
  description: string;
  isLongRunning?: boolean;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const BASE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseTool');

/**
 * Type guard to check if an object is an instance of BaseTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseTool, false otherwise.
 */
export function isBaseTool(obj: unknown): obj is BaseTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[BASE_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * The base class for all tools.
 */
export abstract class BaseTool {
  /** A unique symbol to identify ADK base tool class. */
  readonly [BASE_TOOL_SIGNATURE_SYMBOL] = true;

  readonly name: string;
  readonly description: string;
  readonly isLongRunning: boolean;

  /**
   * Base constructor for a tool.
   *
   * @param params The parameters for `BaseTool`.
   */
  constructor(params: BaseToolParams) {
    this.name = params.name;
    this.description = params.description;
    this.isLongRunning = params.isLongRunning ?? false;
  }

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
  _getDeclaration(): FunctionDeclaration | undefined {
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
   * @param request The request to run the tool.
   * @return A promise that resolves to the tool response.
   */
  abstract runAsync(request: RunAsyncToolRequest): Promise<unknown>;

  /**
   * Whether this tool needs a human to approve `args` before it runs.
   *
   * The gate itself lives in the tool that owns it (see `FunctionTool`), but
   * the resume path has to ask the same question a turn later, to check that an
   * approval it is about to honour belongs to a tool that gates at all. A tool
   * that never gates returns false here, which is the safe default: an approval
   * naming it is meaningless and gets rejected rather than executed. Mirrors
   * Python's `BaseTool.check_require_confirmation`.
   *
   * @param _args The arguments the tool would run with.
   * @param _toolContext The context of the call, when there is one.
   * @return Whether the call requires confirmation.
   */
  async checkRequireConfirmation(
    _args: Record<string, unknown>,
    _toolContext?: Context,
  ): Promise<boolean> {
    return false;
  }

  /**
   * Processes the outgoing LLM request for this tool.
   *
   * Use cases:
   * - Most common use case is adding this tool to the LLM request.
   * - Some tools may just preprocess the LLM request before it's sent out.
   *
   * @param request The request to process the LLM request.
   */
  async processLlmRequest({llmRequest}: ToolProcessLlmRequest): Promise<void> {
    const functionDeclaration = this._getDeclaration();
    if (!functionDeclaration) {
      return;
    }

    if (this.name in llmRequest.toolsDict) {
      throw new Error(`Duplicate tool name: ${this.name}`);
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

function findToolWithFunctionDeclarations(
  llmRequest: LlmRequest,
): Tool | undefined {
  return (llmRequest.config?.tools || []).find(
    (tool) => 'functionDeclarations' in tool,
  ) as Tool | undefined;
}
