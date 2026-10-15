/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {BaseTool} from '../base_tool.js';

/**
 * Unique symbol to identify `BaseRetrievalTool` classes.
 * Defined once and shared by all `BaseRetrievalTool` instances.
 */
const BASE_RETRIEVAL_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.baseRetrievalTool',
);

/**
 * Type guard to check if an object is an instance of `BaseRetrievalTool`.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of `BaseRetrievalTool`, false otherwise.
 */
export function isBaseRetrievalTool(obj: unknown): obj is BaseRetrievalTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_RETRIEVAL_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[BASE_RETRIEVAL_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * The base class for tools that answer a single natural-language query by
 * retrieving text the framework fetches itself.
 *
 * Subclasses supply `runAsync`; this class supplies the declaration the model
 * sees, so every retrieval tool advertises the same one-argument `query`
 * signature whatever store backs it.
 *
 * Ported from adk-python
 * `src/google/adk/tools/retrieval/base_retrieval_tool.py` at ref `v0.1.0`.
 */
export abstract class BaseRetrievalTool extends BaseTool {
  /** Unique symbol to identify `BaseRetrievalTool` class. */
  readonly [BASE_RETRIEVAL_TOOL_SIGNATURE_SYMBOL] = true;

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The query to retrieve.',
          },
        },
      },
    };
  }
}
