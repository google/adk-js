/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {BaseTool} from '../base_tool.js';

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
