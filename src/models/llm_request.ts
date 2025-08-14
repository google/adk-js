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
export class LlmRequest {
  /**
   * The model name.
   */
  model?: string;

  /**
   * The contents to send to the model.
   */
  contents: Content[] = [];

  /**
   * Additional config for the generate content request.
   * Tools in generateContentConfig should not be set directly; use appendTools.
   */
  config?: GenerateContentConfig;

  liveConnectConfig: LiveConnectConfig = {};

  /**
   * The tools dictionary. Excluded from JSON serialization.
   */
  toolsDict: {[key: string]: BaseTool} = {};

  /**
   * Creates an instance of LlmRequest.
   */
  constructor(initialData?: Partial<LlmRequest>) {
    Object.assign(this, initialData);
  }

  /**
   * Appends instructions to the system instruction.
   * @param instructions The instructions to append.
   */
  appendInstructions(instructions: string[]): void {
    if (!this.config) {
      this.config = {};
    }
    const newInstructions = instructions.join('\n\n');
    if (this.config.systemInstruction) {
      this.config.systemInstruction += '\n\n' + newInstructions;
    } else {
      this.config.systemInstruction = newInstructions;
    }
  }

  /**
   * Appends tools to the request.
   * @param tools The tools to append.
   */
  appendTools(tools: BaseTool[]): void {
    if (!tools?.length) {
      return;
    }

    const declarations: FunctionDeclaration[] = [];
    for (const tool of tools) {
      const declaration = tool._getDeclaration();
      if (declaration) {
        declarations.push(declaration);
        this.toolsDict[tool.name] = tool;
      }
    }

    if (declarations.length) {
      if (!this.config) {
        this.config = {};
      }
      if (!this.config.tools) {
        this.config.tools = [];
      }
      this.config.tools.push({functionDeclarations: declarations});
    }
  }

  /**
   * Sets the output schema for the request.
   *
   * @param schema The JSON Schema object to set as the output schema.
   */
  setOutputSchema(schema: SchemaUnion): void {
    if (!this.config) {
      this.config = {};
    }
    this.config.responseSchema = schema;
    this.config.responseMimeType = 'application/json';
  }

  /**
   * Custom serialization method used by `JSON.stringify()`.
   * This replicates Pydantic's `exclude=True` behavior for `toolsDict`.
   */
  toJSON() {
    const {toolsDict, ...serializableData} = this;
    return serializableData;
  }

  /**
   * Creates a new LlmRequest instance from a JSON string or plain object,
   * restoring its methods.
   */
  static fromJSON(source: object|string): LlmRequest {
    const plainObject =
        typeof source === 'string' ? JSON.parse(source) : source;
    return new LlmRequest(plainObject as Partial<LlmRequest>);
  }
}
