/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import type {MemoryEntry} from '../memory/memory_entry.js';
import {appendInstructions} from '../models/llm_request.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

/**
 * Configuration options for {@link LoadMemoryTool}.
 */
export interface LoadMemoryToolOptions {
  /**
   * Whether to flatten memory content into space-separated text strings.
   *
   * @deprecated Set `textOnlyContent: true` only to retain legacy string content. The default is `false`, returning complete {@link MemoryEntry} objects. This option will be removed in a future release.
   */
  readonly textOnlyContent?: boolean;
}

/**
 * Response returned by {@link LoadMemoryTool}.
 *
 * By default, `memories` contains complete {@link MemoryEntry} objects.
 * When {@link LoadMemoryToolOptions.textOnlyContent} is `true`, each entry
 * contains a flattened `string` in `content` alongside `author` and
 * `timestamp`.
 */
export interface LoadMemoryResponse<T = MemoryEntry> {
  memories: T[];
}

/**
 * A tool that loads memory entries for the current user.
 *
 * By default, returns complete {@link MemoryEntry} objects.
 */
export class LoadMemoryTool extends BaseTool {
  private readonly textOnlyContent: boolean;

  constructor(options: LoadMemoryToolOptions = {}) {
    super({
      name: 'load_memory',
      description: 'Loads the memory for the current user.',
    });
    this.textOnlyContent = options.textOnlyContent ?? false;
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

  override async runAsync({args, toolContext}: RunAsyncToolRequest): Promise<
    LoadMemoryResponse<
      | MemoryEntry
      | {
          content: string;
          author?: string;
          timestamp?: string;
        }
    >
  > {
    const query = args['query'] as string;
    if (!toolContext.invocationContext.memoryService) {
      throw new Error('Memory service is not initialized.');
    }
    const searchMemoryResponse = await toolContext.searchMemory(query);
    if (this.textOnlyContent) {
      return {
        memories: searchMemoryResponse.memories.map((m) => ({
          // Join all text parts by a space, or empty string if no text parts
          content: m.content.parts?.map((p) => p.text ?? '').join(' ') ?? '',
          author: m.author,
          timestamp: m.timestamp,
        })),
      };
    }
    return {
      memories: searchMemoryResponse.memories,
    };
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
