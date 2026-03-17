/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {appendInstructions} from '../models/llm_request.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

/**
 * A tool that loads the memory for the current user.
 *
 * NOTE: Currently this tool only uses text part from the memory.
 */
export class LoadMemoryTool extends BaseTool {
  constructor() {
    super({
      name: 'load_memory',
      description:
        'Loads the memory for the current user.\n\nNOTE: Currently this tool only uses text part from the memory.',
    });
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The query to load the memory for.',
          },
        },
        required: ['query'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    try {
      const query = args['query'] as string;
      if (!toolContext.invocationContext.memoryService) {
        throw new Error('Memory service is not initialized.');
      }
      const searchMemoryResponse = await toolContext.searchMemory(query);
      return {
        memories: searchMemoryResponse.memories.map((m) => ({
          // Join all text parts by a space, or empty string if no text parts
          content: m.content.parts?.map((p) => p.text ?? '').join(' ') ?? '',
          author: m.author,
          timestamp: m.timestamp,
        })),
      };
    } catch (e) {
      console.error('ERROR in LoadMemoryTool runAsync:', e);
      throw e;
    }
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);

    // Only tell the model about memory if memoryService is initialized
    if (!request.toolContext.invocationContext.memoryService) {
      return;
    }

    appendInstructions(request.llmRequest, [
      `You have memory. You can use it to answer questions. If any questions need\nyou to look up the memory, you should call load_memory function with a query.`,
    ]);
  }
}

/**
 * A global instance of {@link LoadMemoryTool}.
 */
export const LOAD_MEMORY = new LoadMemoryTool();
