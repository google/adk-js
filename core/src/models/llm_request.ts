/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionDeclaration, GenerateContentConfig, LiveConnectConfig, SchemaUnion} from '@google/genai';

import {BaseTool} from '../tools/base_tool.js';

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

  /**
   * Appends tools to the request.
   * @param tools The tools to append.
   */
export function appendTools(
    llmRequest: LlmRequest,
    tools: BaseTool[],
    ): void {
  if (!tools?.length) {
    return;
  }

  const functionDeclarations: FunctionDeclaration[] = [];
  for (const tool of tools) {
    const declaration = tool._getDeclaration();
    if (declaration) {
      functionDeclarations.push(declaration);
      llmRequest.toolsDict[tool.name] = tool;
    }
  }

  if (functionDeclarations.length) {
    if (!llmRequest.config) {
      llmRequest.config = {};
    }
    if (!llmRequest.config.tools) {
      llmRequest.config.tools = [];
    }
    llmRequest.config.tools.push({functionDeclarations});
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
