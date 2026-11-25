/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  LiveConnectConfig,
  SchemaUnion,
  Tool,
} from '@google/genai';

import type {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';

/**
 * LLM request class that allows passing in tools, output schema and system
 * instructions to the model.
 */
export interface LlmRequest {
  /**
   * The model name.
   */
  model?: string;

  /**
   * The contents to send to the model.
   */
  contents: Content[];

  /**
   * Additional config for the generate content request.
   * Tools in generateContentConfig should not be set directly; use appendTools.
   */
  config?: GenerateContentConfig;

  liveConnectConfig: LiveConnectConfig;

  /**
   * The tools dictionary. Excluded from JSON serialization.
   */
  toolsDict: {[key: string]: BaseTool};

  /**
   * The set of allowed tools, populated by request processors.
   */
  allowedTools?: string[];

  /**
   * The interaction ID from the previous turn, if any.
   */
  previousInteractionId?: string;
}

/**
 * Appends instructions to the system instruction.
 * @param instructions The instructions to append.
 */
export function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[],
): void {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  const newInstructions = instructions.join('\n\n');
  if (llmRequest.config.systemInstruction) {
    llmRequest.config.systemInstruction += '\n\n' + newInstructions;
  } else {
    llmRequest.config.systemInstruction = newInstructions;
  }
}

const IN_MODEL_TOOL_SYMBOL = Symbol.for('google.adk.inModelTool');

function isInModelToolEntry(tool: unknown): boolean {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    IN_MODEL_TOOL_SYMBOL in tool &&
    tool[IN_MODEL_TOOL_SYMBOL] === true
  );
}

function isToolWithFunctionDeclarations(
  tool: unknown,
): tool is Tool & {functionDeclarations: FunctionDeclaration[]} {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    'functionDeclarations' in tool &&
    Array.isArray(tool.functionDeclarations)
  );
}

function findToolWithFunctionDeclarations(
  llmRequest: LlmRequest,
): (Tool & {functionDeclarations: FunctionDeclaration[]}) | undefined {
  return llmRequest.config?.tools?.find(isToolWithFunctionDeclarations);
}

/**
 * Appends tools to the request.
 * @param tools The tools to append.
 */
export function appendTools(llmRequest: LlmRequest, tools: BaseTool[]): void {
  if (!tools?.length) {
    return;
  }

  const functionDeclarations: FunctionDeclaration[] = [];
  for (const tool of tools) {
    const declaration = tool._getDeclaration();
    if (declaration) {
      functionDeclarations.push(declaration);
      if (
        Object.hasOwn(llmRequest.toolsDict, tool.name) &&
        !isInModelToolEntry(llmRequest.toolsDict[tool.name])
      ) {
        logger.warn(
          `Duplicate tool name "${tool.name}": the previously registered tool is shadowed and can no longer be called.`,
        );
      }
      llmRequest.toolsDict[tool.name] = tool;
    }
  }

  if (functionDeclarations.length) {
    llmRequest.config ??= {};
    llmRequest.config.tools ??= [];

    const existingTool = findToolWithFunctionDeclarations(llmRequest);
    if (existingTool) {
      existingTool.functionDeclarations.push(...functionDeclarations);
    } else {
      llmRequest.config.tools.push({functionDeclarations});
    }
  }
}

/**
 * Sets the output schema for the request.
 *
 * @param schema The JSON Schema object to set as the output schema.
 */
export function setOutputSchema(
  llmRequest: LlmRequest,
  schema: SchemaUnion,
): void {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  llmRequest.config.responseSchema = schema;
  llmRequest.config.responseMimeType = 'application/json';
}
