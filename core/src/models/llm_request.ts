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
  Part,
  SchemaUnion,
} from '@google/genai';

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
 * Distinguishes a `Content` object from a `Part` within `ContentUnion`.
 * Neither `parts` nor `role` exists on `@google/genai`'s `Part`.
 */
export function isContentObject(value: Content | Part): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('parts' in value || 'role' in value)
  );
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
  const existing = llmRequest.config.systemInstruction;
  if (!existing) {
    llmRequest.config.systemInstruction = newInstructions;
  } else if (typeof existing === 'string') {
    llmRequest.config.systemInstruction = `${existing}\n\n${newInstructions}`;
  } else if (Array.isArray(existing)) {
    llmRequest.config.systemInstruction = [
      ...existing,
      {text: newInstructions},
    ];
  } else if (typeof existing === 'object' && isContentObject(existing)) {
    llmRequest.config.systemInstruction = {
      ...existing,
      parts: [...(existing.parts ?? []), {text: newInstructions}],
    };
  } else {
    llmRequest.config.systemInstruction = [existing, {text: newInstructions}];
  }
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
